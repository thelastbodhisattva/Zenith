import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  recordRebalance,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { evaluatePortfolioGuard } from "../portfolio-guards.js";
import { DEPLOY_GOVERNANCE_CODES, evaluateDeployAdmission } from "../runtime-policy.js";
import { estimateInitialValueUsd } from "../runtime-helpers.js";
import { getPoolDeployCooldown } from "../pool-memory.js";
import { appendActionLifecycle } from "../action-journal.js";
import { getWalletBalances, normalizeMint } from "./wallet.js";
import { fetchWithTimeout } from "./fetch-utils.js";
import {
	calculateDynamicBinTierPlan,
	chooseDistributionStrategyPlan,
} from "./dlmm-planner.js";
import {
	buildPoolPlanningData,
	calculateBalanceDeltas,
	classifyRangeLocation,
	getOutOfRangeDirection,
	normalizeCompoundingLocation,
	resolveBinSnapshot,
	resolveCompoundingBias,
} from "./dlmm-rebalance-helpers.js";
import {
	buildTrackedPositionFallback,
	captureBalanceSnapshotForMints,
	getPositionExecutionContext,
	resolvePoolTokenMints,
} from "./dlmm-position-context.js";
import {
	buildClosePerformancePayload,
	evaluatePostCloseSettlementObservation,
	getWalletTokenBalance,
	waitForPostCloseSettlement,
} from "./dlmm-settlement.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

const MAX_BINS_PER_SIDE = 34;

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampWholeNumber(value, min, max) {
  return Math.round(clampNumber(toFiniteNumber(value, min), min, max));
}

function roundMetric(value, decimals = 4) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}


async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

export async function getPoolGovernanceMetadata({ pool_address }) {
	pool_address = normalizeMint(pool_address);
	try {
		const pool = await getPool(pool_address);
		return {
			pool_address,
			base_mint: pool?.lbPair?.tokenXMint?.toString() || null,
			bin_step: pool?.lbPair?.binStep ?? null,
		};
	} catch (error) {
		return { error: error.message };
	}
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

export async function chooseDistributionStrategy({ pool_data = {}, expected_volume_profile = "balanced" }) {
  return chooseDistributionStrategyPlan({ pool_data, expected_volume_profile });
}

export async function calculateDynamicBinTiers({ six_hour_volatility, trend_bias = "neutral" }) {
  return calculateDynamicBinTierPlan(six_hour_volatility, trend_bias);
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  decision_context = null,
  bypass_portfolio_guard = false,
}) {
  pool_address = normalizeMint(pool_address);
  const portfolioGuard = evaluatePortfolioGuard();
  const cooldown = getPoolDeployCooldown({ pool_address });
  const deployAdmission = evaluateDeployAdmission({
    config,
    poolAddress: pool_address,
    amountY: amount_y ?? amount_sol ?? 0,
    amountX: amount_x ?? 0,
    portfolioGuard,
    poolCooldown: cooldown,
    enforcePositionLimit: false,
    enforceExposure: false,
    enforceBinStep: false,
    enforceSize: false,
    enforceBalance: false,
  });
  if (!deployAdmission.pass) {
    if (deployAdmission.code === DEPLOY_GOVERNANCE_CODES.PORTFOLIO_GUARD_ACTIVE) {
      if (!bypass_portfolio_guard) {
        return {
          success: false,
          blocked: true,
          reason: "portfolio_guard_pause_active",
          pool: pool_address,
          pause_until: portfolioGuard.pause_until,
          guard_reason: portfolioGuard.reason,
          guard_reason_code: portfolioGuard.reason_code,
        };
      }
    }
    if (deployAdmission.code === DEPLOY_GOVERNANCE_CODES.POOL_LOW_YIELD_COOLDOWN_ACTIVE) {
      return {
        success: false,
        blocked: true,
        reason: "pool_low_yield_cooldown_active",
        pool: pool_address,
        cooldown_until: cooldown.cooldown_until,
        cooldown_reason: cooldown.reason,
        remaining_minutes: Math.ceil((cooldown.remaining_ms || 0) / 60000),
      };
    }
  }

  const activeStrategy = strategy || config.strategy.strategy;

  const activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  const activeBinsAbove = bins_above ?? 0;

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;
	const walletBalances = await getWalletBalances({}).catch(() => null);
	const solPrice = Number(walletBalances?.sol_price) || 0;
	const deployValueUsd = estimateInitialValueUsd({
		amountSol: finalAmountY,
		solPrice,
		amountToken: finalAmountX,
		activePrice: Number(activeBin.price),
	});

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers, { skipPreflight: true });
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet], { skipPreflight: true });
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition], { skipPreflight: true });
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      base_mint: pool.lbPair.tokenXMint.toString(),
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd: deployValueUsd,
      opened_by_cycle_id: decision_context?.cycle_id || null,
      opened_by_action_id: decision_context?.action_id || null,
      opened_by_workflow_id: decision_context?.workflow_id || null,
      regime_label: decision_context?.regime_label || null,
    });

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat(activeBin.price);
    const minPrice = activePrice * Math.pow(1 + actualBinStep / 10000, minBinId - activeBin.binId);
    const maxPrice = activePrice * Math.pow(1 + actualBinStep / 10000, maxBinId - activeBin.binId);

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      bin_step: actualBinStep,
      base_fee: base_fee ?? null,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes
const DLMM_FETCH_TIMEOUT_MS = 15 * 1000;

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: DLMM_FETCH_TIMEOUT_MS,
      timeoutMessage: `DLMM PnL request timed out after ${DLMM_FETCH_TIMEOUT_MS}ms`,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API", stale: true, status: "stale" };
		const observedAtMs = Number.isFinite(Number(p.observed_at_ms ?? p.as_of_ms ?? p.updatedAtMs ?? p.updated_at_ms))
			? Number(p.observed_at_ms ?? p.as_of_ms ?? p.updatedAtMs ?? p.updated_at_ms)
			: null;
    const staleWithoutFreshness = observedAtMs == null;

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
			observed_at_ms: observedAtMs,
			max_age_ms: 60_000,
      stale: staleWithoutFreshness,
      status: staleWithoutFreshness ? "stale" : "ok",
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message, stale: true, status: "stale" };
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  // If a scan is already in progress, wait for it instead of starting another
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    log("positions", "Scanning positions via getProgramAccounts...");
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    const walletPubkey = new PublicKey(walletAddress);

    // Owner field sits at offset 40 (8 discriminator + 32 lb_pair)
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: walletPubkey.toBase58() } }],
    });

    log("positions", `Found ${accounts.length} position account(s)`);

    // Collect raw (pool, position) pairs
    const raw = [];
    for (const acc of accounts) {
      const positionAddress = acc.pubkey.toBase58();
      const lbPairKey = new PublicKey(acc.account.data.slice(8, 40)).toBase58();
      const tracked = getTrackedPosition(positionAddress);
      const pair = tracked?.pool_name || lbPairKey.slice(0, 8);
      raw.push({
        position: positionAddress,
        pool: lbPairKey,
        pair,
        pool_name: tracked?.pool_name || null,
        strategy: tracked?.strategy || null,
        bin_range: tracked?.bin_range || null,
        bin_step: tracked?.bin_step ?? null,
        volatility: tracked?.volatility ?? null,
        fee_tvl_ratio: tracked?.fee_tvl_ratio ?? null,
        organic_score: tracked?.organic_score ?? null,
        instruction: tracked?.instruction || null,
        base_mint: null, // enriched from PnL API below
        lower_bin: null,
        upper_bin: null,
      });
    }

    // Enrich with DLMM PnL API for each unique pool in parallel
    const uniquePools = [...new Set(raw.map((p) => p.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, walletAddress)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });
    const mintMaps = await Promise.all(
		uniquePools.map((pool) =>
			resolvePoolTokenMints({
				poolAddress: pool,
				getPool,
			}),
		),
	);
    const mintsByPool = {};
		uniquePools.forEach((pool, i) => {
			const mintMap = mintMaps[i];
			if (mintMap?.error) {
				log("positions_warn", `Pool mint enrichment failed for ${pool.slice(0, 8)}: ${mintMap.error}`);
				mintsByPool[pool] = null;
				return;
			}
			mintsByPool[pool] = mintMap;
		});

    const positions = raw.map((r) => {
    const p = pnlByPool[r.pool]?.[r.position] || null;

      const lowerBin  = p?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? r.upper_bin;
      const activeBin = p?.poolActiveBinId ?? null;
      const oorDirection = getOutOfRangeDirection(lowerBin, upperBin, activeBin);
      const pnlMissing = !p;
      const inRange = p ? !p.isOutOfRange : null;
      if (inRange === true) markInRange(r.position);
      else if (inRange === false) markOutOfRange(r.position, oorDirection);

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = p?.pnlPctChange ?? 0;
      const observedAtMs = Number.isFinite(Number(p?.observed_at_ms ?? p?.as_of_ms ?? p?.updatedAtMs ?? p?.updated_at_ms))
        ? Number(p?.observed_at_ms ?? p?.as_of_ms ?? p?.updatedAtMs ?? p?.updated_at_ms)
        : null;
      const staleWithoutFreshness = p ? observedAtMs == null : false;

      const tracked = getTrackedPosition(r.position);
      const poolMints = mintsByPool[r.pool] || null;
      const ageFromPnlApi = p?.createdAt
        ? Math.floor((Date.now() - p.createdAt * 1000) / 60000)
        : null;
      const ageFromState = tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null;
      const ageMinutes = Math.max(ageFromPnlApi ?? 0, ageFromState ?? 0) || null;

      return {
        position: r.position,
        pool: r.pool,
        pair: r.pair,
        pool_name: r.pool_name,
        strategy: r.strategy,
        bin_range: r.bin_range,
        bin_step: r.bin_step,
        volatility: r.volatility,
        organic_score: r.organic_score,
        instruction: r.instruction,
        amount_sol: tracked?.amount_sol ?? null,
        initial_value_usd: tracked?.initial_value_usd ?? null,
        base_mint: tracked?.base_mint || poolMints?.token_x_mint || r.base_mint,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
			pnl_missing: pnlMissing,
			pnl_error: pnlMissing ? "Position not found in PnL API" : null,
			stale: p?.stale === true || p?.status === "stale" || staleWithoutFreshness,
			status: pnlMissing ? "missing" : (p?.status || (staleWithoutFreshness ? "stale" : "ok")),
			observed_at_ms: observedAtMs,
			max_age_ms: p ? 60_000 : null,
        out_of_range_direction: oorDirection,
        unclaimed_fees_usd: Math.round(unclaimedFees * 100) / 100,
        total_value_usd: Math.round(totalValue * 100) / 100,
        collected_fees_usd: Math.round(collectedFees * 100) / 100,
        pnl_usd: Math.round(pnlUsd * 100) / 100,
        pnl_pct: Math.round(pnlPct * 100) / 100,
        age_minutes: ageMinutes,
        minutes_out_of_range: minutesOutOfRange(r.position),
        fee_tvl_ratio: p?.feeActiveTvlRatio != null
          ? Math.round(p.feeActiveTvlRatio * 10000) / 10000
          : r.fee_tvl_ratio,
      };
    });

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map((p) => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `SDK scan failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });
    const mintMaps = await Promise.all(
		uniquePools.map((pool) =>
			resolvePoolTokenMints({
				poolAddress: pool,
				getPool,
			}),
		),
	);
    const mintsByPool = {};
		uniquePools.forEach((pool, i) => {
			const mintMap = mintMaps[i];
			if (mintMap?.error) {
				log("wallet_positions_warn", `Pool mint enrichment failed for ${pool.slice(0, 8)}: ${mintMap.error}`);
				mintsByPool[pool] = null;
				return;
			}
			mintsByPool[pool] = mintMap;
		});

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const poolMints = mintsByPool[r.pool] || null;
      const oorDirection = getOutOfRangeDirection(p?.lowerBinId ?? null, p?.upperBinId ?? null, p?.poolActiveBinId ?? null);

      return {
        position:           r.position,
        pool:               r.pool,
        base_mint:          poolMints?.token_x_mint || null,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        out_of_range_direction: oorDirection,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: DLMM_FETCH_TIMEOUT_MS,
    timeoutMessage: `Pool search request timed out after ${DLMM_FETCH_TIMEOUT_MS}ms`,
  });
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

function roundAmount(value, decimals = 6) {
  const sanitized = Math.max(0, toFiniteNumber(value, 0));
  const factor = Math.pow(10, decimals);
  return Math.floor(sanitized * factor) / factor;
}


export async function rebalanceOnExit({
  position_address,
  force_rebalance = false,
  expected_volume_profile,
  execute = true,
  journal_workflow_id = null,
  decision_context = null,
} = {}) {
  position_address = normalizeMint(position_address);
  if (!position_address) {
    return { success: false, error: "position_address is required" };
  }

	const context = await getPositionExecutionContext(position_address, {
		getMyPositions,
		getPositionPnl,
		buildTrackedFallback: (address) => buildTrackedPositionFallback(address, { getTrackedPosition }),
		resolveBinSnapshot,
		classifyRangeLocation,
		isDryRun: process.env.DRY_RUN === "true",
	});
  if (context.error) {
    return { success: false, error: context.error, position: position_address };
  }

  const outOfRange = context.in_range === false || context.range_location.in_range === false;
  if (!outOfRange && !force_rebalance) {
    return {
      success: false,
      skipped: true,
      position: position_address,
      reason: "Position is currently in range. Set force_rebalance=true to override.",
      range_snapshot: context.bin_snapshot,
      range_location: context.range_location,
    };
  }

  const planningData = buildPoolPlanningData(context.position, context.bin_snapshot);
  const expectedVolumeProfile = expected_volume_profile || planningData.expected_volume_profile;
  const distributionPlan = await chooseDistributionStrategy({
    pool_data: planningData.pool_data,
    expected_volume_profile: expectedVolumeProfile,
  });
  const tierPlan = await calculateDynamicBinTiers({
    six_hour_volatility: planningData.pool_data.six_hour_volatility,
    trend_bias: planningData.trend_bias,
  });

  const strategy = distributionPlan?.strategy || context.position.strategy || config.strategy.strategy;
  const binsBelow = clampWholeNumber(
    tierPlan?.range_plan?.bins_below ?? config.strategy.binsBelow,
    0,
    MAX_BINS_PER_SIDE
  );
  const binsAbove = strategy === "bid_ask"
    ? 0
    : clampWholeNumber(tierPlan?.range_plan?.bins_above ?? 0, 0, MAX_BINS_PER_SIDE);

  const actionPlan = {
    close_position: { position_address },
    deploy_position: {
      pool_address: context.position.pool,
      pool_name: context.position.pool_name || context.position.pair || null,
      strategy,
      bins_below: binsBelow,
      bins_above: binsAbove,
      amount_x: null,
      amount_y: null,
      amount_source: "post_close_balance_delta",
      bin_step: context.position.bin_step ?? null,
      volatility: planningData.pool_data.six_hour_volatility,
      fee_tvl_ratio: planningData.pool_data.fee_tvl_ratio,
      organic_score: planningData.pool_data.organic_score,
    },
  };

  const dryRun = process.env.DRY_RUN === "true";
  if (dryRun || !execute) {
    return {
      success: true,
      dry_run: dryRun,
      executed: false,
      position: position_address,
      out_of_range: outOfRange,
      force_rebalance: !!force_rebalance,
      range_snapshot: context.bin_snapshot,
      range_location: context.range_location,
      planning: {
        expected_volume_profile: expectedVolumeProfile,
        trend_bias: planningData.trend_bias,
        distribution_plan: distributionPlan,
        tier_plan: tierPlan,
        reinvestment_plan: {
          amount_source: "post_close_balance_delta",
          note: "Live execution redeploy amount is derived only from close balance deltas.",
        },
      },
      action_plan: actionPlan,
      message: dryRun
        ? "DRY RUN — rebalance plan generated, no transactions sent"
        : "Execution disabled — rebalance plan generated",
    };
  }

  if (!context.position.pool) {
    return {
      success: false,
      error: "Cannot execute live rebalance without a pool address",
      position: position_address,
      action_plan: actionPlan,
    };
  }

	const poolTokenMints = await resolvePoolTokenMints({
		poolAddress: context.position.pool,
		getPool,
	});
  if (!poolTokenMints || poolTokenMints.error || !poolTokenMints.token_x_mint || !poolTokenMints.token_y_mint) {
    return {
      success: false,
      error: `Cannot execute live rebalance without pool token mint metadata${poolTokenMints?.error ? `: ${poolTokenMints.error}` : ""}`,
      position: position_address,
      action_plan: actionPlan,
    };
  }

	const beforeCloseSnapshot = await captureBalanceSnapshotForMints({
		token_x_mint: poolTokenMints.token_x_mint,
		token_y_mint: poolTokenMints.token_y_mint,
		phase: "before close",
		getWalletBalances,
		normalizeMint,
		solMint: config.tokens.SOL,
	});
  if (beforeCloseSnapshot?.error) {
    return {
      success: false,
      error: `Cannot execute live rebalance without a pre-close balance snapshot: ${beforeCloseSnapshot.error}`,
      position: position_address,
      action_plan: actionPlan,
    };
  }

  const closeResult = await closePosition({ position_address, decision_context });
  if (!closeResult?.success) {
    return {
      success: false,
      error: closeResult?.error || "Failed to close position for rebalance",
      position: position_address,
      close_result: closeResult,
      action_plan: actionPlan,
    };
  }

  if (journal_workflow_id) {
    appendActionLifecycle({
      workflow_id: journal_workflow_id,
      lifecycle: "close_observed_pending_redeploy",
      tool: "rebalance_on_exit",
      position_address,
      pool_address: context.position.pool,
    });
  }

	const afterCloseSnapshot = await captureBalanceSnapshotForMints({
		token_x_mint: poolTokenMints.token_x_mint,
		token_y_mint: poolTokenMints.token_y_mint,
		phase: "after close",
		getWalletBalances,
		normalizeMint,
		solMint: config.tokens.SOL,
	});
  if (afterCloseSnapshot?.error) {
    return {
      success: false,
      error: `Closed position but cannot determine recovered token deltas: ${afterCloseSnapshot.error}`,
      position: position_address,
      close_result: closeResult,
      action_plan: actionPlan,
    };
  }

  const recoveredDeltaPlan = calculateBalanceDeltas(beforeCloseSnapshot, afterCloseSnapshot);
  if (recoveredDeltaPlan.error) {
    return {
      success: false,
      error: `Closed position but redeploy delta sizing is unsafe: ${recoveredDeltaPlan.error}`,
      position: position_address,
      close_result: closeResult,
      recovered_deltas: {
        delta_x_raw: recoveredDeltaPlan.delta_x_raw ?? null,
        delta_y_raw: recoveredDeltaPlan.delta_y_raw ?? null,
      },
      planning: {
        reinvestment_plan: {
          amount_source: "post_close_balance_delta",
          before_close_snapshot: beforeCloseSnapshot,
          after_close_snapshot: afterCloseSnapshot,
        },
      },
      action_plan: {
        ...actionPlan,
        deploy_position: {
          ...actionPlan.deploy_position,
          amount_x: 0,
          amount_y: 0,
        },
      },
    };
  }

  if (strategy === "bid_ask" && recoveredDeltaPlan.amount_y <= 0) {
    return {
      success: false,
      error: "Closed position but bid_ask redeploy requires quote-side amount_y > 0",
      position: position_address,
      close_result: closeResult,
      planning: {
        reinvestment_plan: {
          amount_source: "post_close_balance_delta",
          recovered_deltas: recoveredDeltaPlan,
        },
      },
      action_plan: {
        ...actionPlan,
        deploy_position: {
          ...actionPlan.deploy_position,
          amount_x: recoveredDeltaPlan.amount_x,
          amount_y: recoveredDeltaPlan.amount_y,
        },
      },
    };
  }

  const deployArgs = {
    ...actionPlan.deploy_position,
    amount_x: recoveredDeltaPlan.amount_x,
    amount_y: recoveredDeltaPlan.amount_y,
    decision_context,
    bypass_portfolio_guard: true,
  };
	const remainingPositions = await getMyPositions({ force: true });
	if (remainingPositions?.error || !Array.isArray(remainingPositions?.positions)) {
		return {
			success: false,
			error: `Rebalance redeploy blocked: unable to verify remaining positions (${remainingPositions?.error || "invalid positions payload"})`,
			position: position_address,
			close_result: closeResult,
		};
	}
	const targetPoolMints = await resolvePoolTokenMints({
		poolAddress: deployArgs.pool_address,
		getPool,
	});
	if (targetPoolMints?.error) {
		return {
			success: false,
			error: `Rebalance redeploy blocked: target pool mint lookup failed (${targetPoolMints.error})`,
			position: position_address,
			close_result: closeResult,
		};
	}
	const rebalanceWallet = await getWalletBalances({});
	const remainingOpenPositions = remainingPositions.positions.filter((position) => position.position !== position_address);
	const redeployAdmission = evaluateDeployAdmission({
		config,
		poolAddress: deployArgs.pool_address,
		baseMint: targetPoolMints.token_x_mint,
		amountY: deployArgs.amount_y ?? 0,
		amountX: deployArgs.amount_x ?? 0,
		binStep: deployArgs.bin_step ?? context.position.bin_step ?? null,
		positions: remainingOpenPositions,
		positionsCount: remainingOpenPositions.length,
		walletSol: rebalanceWallet?.sol ?? null,
		portfolioGuard: evaluatePortfolioGuard({
			portfolioSnapshot: rebalanceWallet,
			openPositionPnls: buildOpenPositionPnlInputs(remainingOpenPositions),
		}),
		poolCooldown: getPoolDeployCooldown({ pool_address: deployArgs.pool_address }),
	});
	if (!redeployAdmission.pass) {
		return {
			success: false,
			error: `Rebalance redeploy blocked: ${redeployAdmission.message}`,
			position: position_address,
			close_result: closeResult,
		};
	}
  const deployResult = await deployPosition(deployArgs);

  if (!deployResult?.success) {
    return {
      success: false,
      error: deployResult?.error || "Rebalance redeploy failed after close",
      position: position_address,
      close_result: closeResult,
      deploy_result: deployResult,
      planning: {
        expected_volume_profile: expectedVolumeProfile,
        trend_bias: planningData.trend_bias,
        distribution_plan: distributionPlan,
        tier_plan: tierPlan,
        reinvestment_plan: {
          amount_source: "post_close_balance_delta",
          recovered_deltas: recoveredDeltaPlan,
          before_close_snapshot: beforeCloseSnapshot,
          after_close_snapshot: afterCloseSnapshot,
        },
      },
      action_plan: {
        ...actionPlan,
        deploy_position: deployArgs,
      },
    };
  }

  recordRebalance(position_address, deployResult.position);

  return {
    success: true,
    rebalanced: true,
    old_position: position_address,
    new_position: deployResult.position,
    close_result: closeResult,
    deploy_result: deployResult,
    range_snapshot: context.bin_snapshot,
    range_location: context.range_location,
    planning: {
      expected_volume_profile: expectedVolumeProfile,
      trend_bias: planningData.trend_bias,
      distribution_plan: distributionPlan,
      tier_plan: tierPlan,
      reinvestment_plan: {
        amount_source: "post_close_balance_delta",
        recovered_deltas: recoveredDeltaPlan,
        before_close_snapshot: beforeCloseSnapshot,
        after_close_snapshot: afterCloseSnapshot,
      },
    },
    action_plan: {
      ...actionPlan,
      deploy_position: deployArgs,
    },
  };
}

export async function autoCompoundFees({
  position_address,
  execute_reinvest = false,
  expected_volume_profile,
  force_claim = false,
} = {}) {
  position_address = normalizeMint(position_address);
  if (!position_address) {
    return { success: false, error: "position_address is required" };
  }

	const context = await getPositionExecutionContext(position_address, {
		getMyPositions,
		getPositionPnl,
		buildTrackedFallback: (address) => buildTrackedPositionFallback(address, { getTrackedPosition }),
		resolveBinSnapshot,
		classifyRangeLocation,
		isDryRun: process.env.DRY_RUN === "true",
	});
  if (context.error) {
    return { success: false, error: context.error, position: position_address };
  }

  const compoundingLocation = normalizeCompoundingLocation(context.range_location);
  const compoundingBias = resolveCompoundingBias(context.range_location);

  const planningData = buildPoolPlanningData(context.position, context.bin_snapshot);
  const expectedVolumeProfile = expected_volume_profile || planningData.expected_volume_profile;
  const distributionPlan = await chooseDistributionStrategy({
    pool_data: planningData.pool_data,
    expected_volume_profile: expectedVolumeProfile,
  });
  const tierPlan = await calculateDynamicBinTiers({
    six_hour_volatility: planningData.pool_data.six_hour_volatility,
    trend_bias: planningData.trend_bias,
  });

  let strategy = distributionPlan?.strategy || context.position.strategy || config.strategy.strategy;
  if (compoundingLocation === "near_upper") strategy = "bid_ask";
  if (compoundingLocation === "near_lower") strategy = "spot";

  const binsBelow = clampWholeNumber(
    tierPlan?.range_plan?.bins_below ?? config.strategy.binsBelow,
    0,
    MAX_BINS_PER_SIDE
  );
  const binsAbove = strategy === "bid_ask"
    ? 0
    : clampWholeNumber(tierPlan?.range_plan?.bins_above ?? 0, 0, MAX_BINS_PER_SIDE);

  const reinvestmentPlan = {
    amount_source: "post_claim_balance_delta",
    amount_x: null,
    amount_y: null,
    bias: compoundingBias,
    in_place_supported: false,
    note: "In-place compounding is not safely implementable with current primitives. Duplicate same-pool deployment is intentionally blocked.",
  };

  const unclaimedFeeUsd = Math.max(
    0,
    toFiniteNumber(context.pnl?.unclaimed_fee_usd ?? context.position.unclaimed_fees_usd, 0)
  );

  const actionPlan = {
    claim_fees: { position_address },
    reinvest_plan: {
      mode: "in_place_only",
      executes_with_current_primitives: false,
      blocked_duplicate_pool_deploy: true,
      blocked_reason: "Current primitives do not support safe in-place compounding. Opening another position in the same pool is blocked.",
      suggested_parameters: {
        pool_address: context.position.pool,
        pool_name: context.position.pool_name || context.position.pair || null,
        strategy,
        bins_below: binsBelow,
        bins_above: binsAbove,
        amount_x: null,
        amount_y: null,
        amount_source: "post_claim_balance_delta",
        bin_step: context.position.bin_step ?? null,
        volatility: planningData.pool_data.six_hour_volatility,
        fee_tvl_ratio: planningData.pool_data.fee_tvl_ratio,
        organic_score: planningData.pool_data.organic_score,
      },
    },
  };

  const dryRun = process.env.DRY_RUN === "true";
  if (dryRun) {
    const claimPreview = await claimFees({ position_address });
    return {
      success: true,
      dry_run: true,
      executed: false,
      position: position_address,
      current_range_location: compoundingLocation,
      current_bias: compoundingBias,
      in_range: context.in_range,
      unclaimed_fee_usd: roundMetric(unclaimedFeeUsd, 2),
      range_snapshot: context.bin_snapshot,
      planning: {
        expected_volume_profile: expectedVolumeProfile,
        trend_bias: planningData.trend_bias,
        distribution_plan: distributionPlan,
        tier_plan: tierPlan,
        reinvestment_plan: reinvestmentPlan,
      },
      claim_preview: claimPreview,
      action_plan: actionPlan,
      message: "DRY RUN — claim + compounding plan generated, no transactions sent",
    };
  }

  if (!force_claim && unclaimedFeeUsd <= 0) {
    return {
      success: true,
      skipped: true,
      position: position_address,
      reason: "No unclaimed fees detected to compound",
      current_range_location: compoundingLocation,
      current_bias: compoundingBias,
      unclaimed_fee_usd: roundMetric(unclaimedFeeUsd, 2),
      planning: {
        expected_volume_profile: expectedVolumeProfile,
        trend_bias: planningData.trend_bias,
        distribution_plan: distributionPlan,
        tier_plan: tierPlan,
        reinvestment_plan: reinvestmentPlan,
      },
      action_plan: actionPlan,
    };
  }

  const claimResult = await claimFees({ position_address });
  if (!claimResult?.success) {
    return {
      success: false,
      error: claimResult?.error || "Failed to claim fees before compounding",
      position: position_address,
      claim_result: claimResult,
      action_plan: actionPlan,
    };
  }

  if (!execute_reinvest) {
    return {
      success: true,
      claimed: true,
      compounded: false,
      position: position_address,
      current_range_location: compoundingLocation,
      current_bias: compoundingBias,
      unclaimed_fee_usd: roundMetric(unclaimedFeeUsd, 2),
      claim_result: claimResult,
      planning: {
        expected_volume_profile: expectedVolumeProfile,
        trend_bias: planningData.trend_bias,
        distribution_plan: distributionPlan,
        tier_plan: tierPlan,
        reinvestment_plan: reinvestmentPlan,
      },
      action_plan: actionPlan,
      message: "Fees claimed. In-place compounding is not safely supported by current primitives; returned a non-executed action plan.",
    };
  }

  return {
    success: true,
    claimed: true,
    compounded: false,
    reinvest_executed: false,
    blocked: true,
    mode: "in_place_only",
    position: position_address,
    current_range_location: compoundingLocation,
    current_bias: compoundingBias,
    unclaimed_fee_usd: roundMetric(unclaimedFeeUsd, 2),
    claim_result: claimResult,
    reason: "execute_reinvest requested, but duplicate-position deployment is blocked and in-place compounding is not safely supported by current primitives.",
    planning: {
      expected_volume_profile: expectedVolumeProfile,
      trend_bias: planningData.trend_bias,
      distribution_plan: distributionPlan,
      tier_plan: tierPlan,
      reinvestment_plan: reinvestmentPlan,
    },
    action_plan: actionPlan,
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  const trackedPosition = getTrackedPosition(position_address);
  if (trackedPosition?.closed) {
    return { success: false, error: `Position ${position_address} is already closed` };
  }
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);
    const baseMint = pool.lbPair.tokenXMint.toString();
    const baseBalanceBeforeClaim = await getWalletTokenBalance({
			walletPubkey: wallet.publicKey,
			mint: baseMint,
			getConnection,
		}).catch(() => null);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);
    const baseBalanceAfterClaim = await getWalletTokenBalance({
			walletPubkey: wallet.publicKey,
			mint: baseMint,
			getConnection,
		}).catch(() => null);
    const baseAmountReceived = computeObservedTokenDelta({
      previousBalance: baseBalanceBeforeClaim,
      observedBalance: baseBalanceAfterClaim,
    });

    return {
      success: true,
      position: position_address,
      txs: txHashes,
      base_mint: baseMint,
      base_amount_received: baseAmountReceived,
    };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason = "agent decision", decision_context = null }) {
  position_address = normalizeMint(position_address);
  const trackedPosition = getTrackedPosition(position_address);
  if (trackedPosition?.closed) {
    return { success: false, error: `Position ${position_address} is already closed` };
  }
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);
    const baseMint = pool.lbPair.tokenXMint.toString();
    const baseBalanceBeforeClose = await getWalletTokenBalance({
			walletPubkey: wallet.publicKey,
			mint: baseMint,
			getConnection,
		}).catch(() => null);

    const positionPubKey = new PublicKey(position_address);

    const txHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    try {
      log("close", `Step 1: Claiming fees for ${position_address}`);
      const positionData = await pool.getPosition(positionPubKey);
      const claimTxs = await pool.claimSwapFee({
        owner: wallet.publicKey,
        position: positionData,
      });
      if (claimTxs && claimTxs.length > 0) {
        for (const tx of claimTxs) {
          const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
          txHashes.push(claimHash);
        }
        log("close", `Step 1 OK: ${txHashes.join(", ")}`);
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    log("close", `Step 2: Removing liquidity and closing account`);
    const closeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });

    for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    const settlement = await waitForPostCloseSettlement({
      walletPubkey: wallet.publicKey,
      baseMint,
      positionAddress: position_address,
      previousBaseBalance: baseBalanceBeforeClose,
			getConnection,
			getMyPositions,
			log,
    });
    if (!settlement.settled) {
      log("close_warn", `Post-close settlement not observed before timeout (${settlement.reason})`);
    }
    recordClose(position_address, reason);

    // Record performance for learning
    const tracked = getTrackedPosition(position_address);
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      // Snapshot PnL from cache BEFORE invalidating — this was the last known state before close
      const closePerformance = buildClosePerformancePayload({
        tracked,
        cachedPosition: _positionsCache?.positions?.find((position) => position.position === position_address),
        poolAddress,
        pool,
        positionAddress: position_address,
        minutesHeld,
        minutesOutOfRange: minutesOOR,
        reason,
        decisionContext: decision_context,
      });
      _positionsCacheAt = 0; // invalidate cache after snapshotting PnL
      await recordPerformance(closePerformance.performance);

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || null,
        txs: txHashes,
        pnl_usd: closePerformance.result.pnl_usd,
        pnl_pct: closePerformance.result.pnl_pct,
        base_mint: baseMint,
        base_amount_received: settlement.observed_balance_delta ?? 0,
        close_reason: reason,
      };
    }

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: null,
      txs: txHashes,
      base_mint: baseMint,
      base_amount_received: settlement.observed_balance_delta ?? 0,
      close_reason: reason,
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}

export { evaluatePostCloseSettlementObservation };
