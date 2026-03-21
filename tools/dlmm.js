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
import { getWalletBalances, normalizeMint } from "./wallet.js";

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
const MIN_BINS_PER_SIDE = 6;

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

function normalizeExpectedVolumeProfile(profile) {
  const normalized = String(profile || "balanced").trim().toLowerCase();
  const profileMap = {
    low: "low",
    light: "low",
    thin: "low",
    balanced: "balanced",
    moderate: "balanced",
    normal: "balanced",
    medium: "balanced",
    high: "high",
    heavy: "high",
    strong: "high",
    bursty: "bursty",
    spiky: "bursty",
    surge: "bursty",
    surging: "bursty",
  };
  return profileMap[normalized] || "balanced";
}

function normalizeTrendBias(trendBias) {
  if (typeof trendBias === "number") {
    const value = clampNumber(trendBias, -1, 1);
    return {
      label: value >= 0.25 ? "bullish" : value <= -0.25 ? "bearish" : "neutral",
      value,
    };
  }

  const normalized = String(trendBias || "neutral").trim().toLowerCase();
  const trendMap = {
    bullish: 0.75,
    bull: 0.75,
    up: 0.75,
    uptrend: 0.75,
    bearish: -0.75,
    bear: -0.75,
    down: -0.75,
    downtrend: -0.75,
    neutral: 0,
    flat: 0,
    sideways: 0,
    range: 0,
  };
  const value = trendMap[normalized] ?? 0;
  return {
    label: value >= 0.25 ? "bullish" : value <= -0.25 ? "bearish" : "neutral",
    value,
  };
}

function normalizeWeights(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return weights.map(() => roundMetric(1 / weights.length));
  }
  return weights.map((weight) => roundMetric(weight / total));
}

function splitIntegerByWeights(total, weights) {
  if (total <= 0) return weights.map(() => 0);

  const normalizedWeights = normalizeWeights(weights);
  const positiveIndexes = normalizedWeights
    .map((weight, index) => (weight > 0 ? index : -1))
    .filter((index) => index >= 0);
  const guaranteed = total >= positiveIndexes.length ? 1 : 0;
  const segments = normalizedWeights.map((weight) => (weight > 0 ? guaranteed : 0));
  let remaining = total - segments.reduce((sum, segment) => sum + segment, 0);

  if (remaining <= 0) {
    return segments;
  }

  const rawAllocations = normalizedWeights.map((weight, index) => ({
    index,
    raw: weight * remaining,
  }));

  for (const allocation of rawAllocations) {
    const whole = Math.floor(allocation.raw);
    segments[allocation.index] += whole;
    remaining -= whole;
    allocation.fraction = allocation.raw - whole;
  }

  rawAllocations
    .sort((a, b) => (b.fraction || 0) - (a.fraction || 0))
    .slice(0, remaining)
    .forEach(({ index }) => {
      segments[index] += 1;
    });

  return segments;
}

function resolveSideBinTarget(sixHourVolatility) {
  const volatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
  if (volatility <= 2) return 10;
  if (volatility <= 4) return 12;
  if (volatility <= 8) return 16;
  if (volatility <= 12) return 20;
  if (volatility <= 18) return 24;
  if (volatility <= 25) return 30;
  return MAX_BINS_PER_SIDE;
}

function resolveTierSplitWeights(sixHourVolatility) {
  const volatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
  if (volatility <= 6) return { outer: 0.2, inner: 0.25, center: 0.55 };
  if (volatility <= 12) return { outer: 0.22, inner: 0.28, center: 0.5 };
  if (volatility <= 18) return { outer: 0.24, inner: 0.3, center: 0.46 };
  if (volatility <= 25) return { outer: 0.26, inner: 0.31, center: 0.43 };
  return { outer: 0.28, inner: 0.32, center: 0.4 };
}

function normalizePoolPlanningInputs(poolData = {}) {
  return {
    volatility: Math.max(
      0,
      toFiniteNumber(poolData.six_hour_volatility ?? poolData.volatility_6h ?? poolData.volatility, 0)
    ),
    feeTvlRatio: Math.max(0, toFiniteNumber(poolData.fee_tvl_ratio ?? poolData.feeActiveTvlRatio, 0)),
    organicScore: Math.max(0, toFiniteNumber(poolData.organic_score ?? poolData.organic, 0)),
    binStep: Math.max(0, toFiniteNumber(poolData.bin_step, 0)),
    priceChangePct: toFiniteNumber(
      poolData.price_change_pct ?? poolData.priceChangePct ?? poolData.price_change_24h,
      0
    ),
    activeTvl: Math.max(0, toFiniteNumber(poolData.active_tvl ?? poolData.tvl ?? poolData.liquidity, 0)),
    volume24h: Math.max(0, toFiniteNumber(poolData.volume_24h ?? poolData.trade_volume_24h, 0)),
  };
}

function buildDistributionWeights(strategy, volumeProfile, priceChangePct) {
  const inferredTrend = normalizeTrendBias(clampNumber(priceChangePct / 20, -1, 1));

  if (strategy === "bid_ask") {
    const lowerWeight = 0.68 - Math.max(0, inferredTrend.value) * 0.08 + Math.max(0, -inferredTrend.value) * 0.06;
    const centerWeight = volumeProfile === "bursty" ? 0.36 : volumeProfile === "high" ? 0.34 : 0.32;
    const normalized = normalizeWeights([lowerWeight, centerWeight, 0]);
    return {
      lower: normalized[0],
      center: normalized[1],
      upper: normalized[2],
      tokenBias: "quote_heavy",
      activeBinTreatment: "defensive",
      inferredTrend,
    };
  }

  let lowerWeight = 0.24;
  const centerWeight = volumeProfile === "high" ? 0.56 : volumeProfile === "bursty" ? 0.48 : 0.52;
  let upperWeight = 0.24;

  if (inferredTrend.value > 0) {
    const shift = 0.08 * inferredTrend.value;
    lowerWeight -= shift;
    upperWeight += shift;
  } else if (inferredTrend.value < 0) {
    const shift = 0.08 * Math.abs(inferredTrend.value);
    lowerWeight += shift;
    upperWeight -= shift;
  }

  const normalized = normalizeWeights([lowerWeight, centerWeight, upperWeight]);
  return {
    lower: normalized[0],
    center: normalized[1],
    upper: normalized[2],
    tokenBias: "balanced",
    activeBinTreatment: volumeProfile === "bursty" ? "buffered" : "balanced",
    inferredTrend,
  };
}

function buildTierRange(side, startOffset, endOffset, binsBelow, binsAbove, includesActiveBin = false) {
  return {
    side,
    start_offset: startOffset,
    end_offset: endOffset,
    bins_below: clampWholeNumber(binsBelow, 0, MAX_BINS_PER_SIDE),
    bins_above: clampWholeNumber(binsAbove, 0, MAX_BINS_PER_SIDE),
    includes_active_bin: includesActiveBin,
  };
}

function buildDynamicBinTierPlan(sixHourVolatility, trendBias = "neutral") {
  const normalizedVolatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
  const normalizedTrend = normalizeTrendBias(trendBias);
  const baseSideBins = resolveSideBinTarget(normalizedVolatility);
  const lowerMultiplier = normalizedTrend.value < 0
    ? 1 + Math.abs(normalizedTrend.value) * 0.25
    : 1 - normalizedTrend.value * 0.15;
  const upperMultiplier = normalizedTrend.value > 0
    ? 1 + normalizedTrend.value * 0.25
    : 1 - Math.abs(normalizedTrend.value) * 0.15;

  const lowerTotal = clampWholeNumber(baseSideBins * lowerMultiplier, MIN_BINS_PER_SIDE, MAX_BINS_PER_SIDE);
  const upperTotal = clampWholeNumber(baseSideBins * upperMultiplier, MIN_BINS_PER_SIDE, MAX_BINS_PER_SIDE);
  const splitWeights = resolveTierSplitWeights(normalizedVolatility);

  const [lowerOuterBins, lowerInnerBins, centerLowerBins] = splitIntegerByWeights(lowerTotal, [
    splitWeights.outer,
    splitWeights.inner,
    splitWeights.center,
  ]);
  const [centerUpperBins, upperInnerBins, upperOuterBins] = splitIntegerByWeights(upperTotal, [
    splitWeights.center,
    splitWeights.inner,
    splitWeights.outer,
  ]);

  const lowerSideAllocation = 0.34 - normalizedTrend.value * 0.1;
  const upperSideAllocation = 0.34 + normalizedTrend.value * 0.1;
  const [lowerOuterWeight, lowerInnerWeight, centerWeight, upperInnerWeight, upperOuterWeight] = normalizeWeights([
    lowerSideAllocation * 0.35,
    lowerSideAllocation * 0.65,
    0.32,
    upperSideAllocation * 0.65,
    upperSideAllocation * 0.35,
  ]);

  const centerStart = centerLowerBins > 0 ? -centerLowerBins : 0;
  const centerEnd = centerUpperBins > 0 ? centerUpperBins : 0;
  const lowerInnerStart = -(centerLowerBins + lowerInnerBins);
  const lowerInnerEnd = -(centerLowerBins + 1);
  const lowerOuterEnd = -(centerLowerBins + lowerInnerBins + 1);
  const upperInnerStart = centerUpperBins + 1;
  const upperInnerEnd = centerUpperBins + upperInnerBins;
  const upperOuterStart = centerUpperBins + upperInnerBins + 1;

  const tiers = [
    {
      id: "lower_outer",
      label: "Lower Outer",
      allocation_weight: lowerOuterWeight,
      ...buildTierRange("lower", -lowerTotal, lowerOuterEnd, lowerOuterBins, 0),
    },
    {
      id: "lower_inner",
      label: "Lower Inner",
      allocation_weight: lowerInnerWeight,
      ...buildTierRange("lower", lowerInnerStart, lowerInnerEnd, lowerInnerBins, 0),
    },
    {
      id: "center",
      label: "Center",
      allocation_weight: centerWeight,
      ...buildTierRange("center", centerStart, centerEnd, centerLowerBins, centerUpperBins, true),
    },
    {
      id: "upper_inner",
      label: "Upper Inner",
      allocation_weight: upperInnerWeight,
      ...buildTierRange("upper", upperInnerStart, upperInnerEnd, 0, upperInnerBins),
    },
    {
      id: "upper_outer",
      label: "Upper Outer",
      allocation_weight: upperOuterWeight,
      ...buildTierRange("upper", upperOuterStart, upperTotal, 0, upperOuterBins),
    },
  ];

  return {
    six_hour_volatility: roundMetric(normalizedVolatility, 2),
    trend_bias: normalizedTrend.label,
    trend_bias_score: roundMetric(normalizedTrend.value, 2),
    max_bins_per_side: MAX_BINS_PER_SIDE,
    range_plan: {
      bins_below: lowerTotal,
      bins_above: upperTotal,
      total_bins: lowerTotal + upperTotal,
      center_bin_included: true,
      hard_clamped: lowerTotal === MAX_BINS_PER_SIDE || upperTotal === MAX_BINS_PER_SIDE,
    },
    distribution_weights: {
      lower: roundMetric(lowerOuterWeight + lowerInnerWeight),
      center: centerWeight,
      upper: roundMetric(upperInnerWeight + upperOuterWeight),
    },
    tiers,
  };
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
  const poolData = normalizePoolPlanningInputs(pool_data);
  const volumeProfile = normalizeExpectedVolumeProfile(expected_volume_profile);

  let spotScore = 0;
  let bidAskScore = 0;

  if (volumeProfile === "high") spotScore += 2;
  if (volumeProfile === "balanced") {
    spotScore += 1;
    bidAskScore += 1;
  }
  if (volumeProfile === "low") bidAskScore += 2;
  if (volumeProfile === "bursty") bidAskScore += 2;

  if (poolData.volatility >= 18) bidAskScore += 2;
  else if (poolData.volatility >= 10) {
    bidAskScore += 1;
    spotScore += 1;
  } else {
    spotScore += 2;
  }

  if (Math.abs(poolData.priceChangePct) >= 15) bidAskScore += 2;
  else if (Math.abs(poolData.priceChangePct) >= 8) bidAskScore += 1;
  else spotScore += 1;

  if (poolData.feeTvlRatio >= 0.08) spotScore += 2;
  else if (poolData.feeTvlRatio >= 0.04) {
    spotScore += 1;
    bidAskScore += 1;
  } else {
    bidAskScore += 1;
  }

  if (poolData.binStep >= 110) bidAskScore += 1;
  else if (poolData.binStep > 0 && poolData.binStep <= 90) spotScore += 1;

  if (poolData.organicScore >= 80) spotScore += 1;
  else if (poolData.organicScore > 0 && poolData.organicScore < 65) bidAskScore += 1;

  if (poolData.activeTvl >= 100000) spotScore += 1;
  else if (poolData.activeTvl > 0 && poolData.activeTvl < 25000) bidAskScore += 1;

  const strategy = spotScore > bidAskScore
    ? "spot"
    : bidAskScore > spotScore
      ? "bid_ask"
      : volumeProfile === "high" || volumeProfile === "balanced"
        ? "spot"
        : "bid_ask";

  const distribution = buildDistributionWeights(strategy, volumeProfile, poolData.priceChangePct);

  return {
    strategy,
    expected_volume_profile: volumeProfile,
    strategy_scores: {
      bid_ask: bidAskScore,
      spot: spotScore,
    },
    distribution_plan: {
      lower_allocation: distribution.lower,
      center_allocation: distribution.center,
      upper_allocation: distribution.upper,
      lower_enabled: true,
      center_enabled: true,
      upper_enabled: strategy === "spot",
      token_bias: distribution.tokenBias,
      active_bin_treatment: distribution.activeBinTreatment,
    },
    pool_snapshot: {
      volatility: roundMetric(poolData.volatility, 2),
      fee_tvl_ratio: roundMetric(poolData.feeTvlRatio, 4),
      organic_score: roundMetric(poolData.organicScore, 2),
      bin_step: poolData.binStep,
      price_change_pct: roundMetric(poolData.priceChangePct, 2),
      active_tvl: roundMetric(poolData.activeTvl, 2),
      volume_24h: roundMetric(poolData.volume24h, 2),
    },
    next_step_inputs: {
      six_hour_volatility: roundMetric(poolData.volatility, 2),
      trend_bias: distribution.inferredTrend.label,
      max_bins_per_side: MAX_BINS_PER_SIDE,
    },
    supported_strategies: ["bid_ask", "spot"],
  };
}

export async function calculateDynamicBinTiers({ six_hour_volatility, trend_bias = "neutral" }) {
  return buildDynamicBinTierPlan(six_hour_volatility, trend_bias);
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
}) {
  pool_address = normalizeMint(pool_address);
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
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
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

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
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
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
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

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      const inRange = p ? !p.isOutOfRange : true;
      if (inRange) markInRange(r.position);
      else markOutOfRange(r.position);

      const lowerBin  = p?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? r.upper_bin;
      const activeBin = p?.poolActiveBinId ?? null;

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = p?.pnlPctChange ?? 0;

      const tracked = getTrackedPosition(r.position);
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
        base_mint: r.base_mint,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
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

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
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
  const res = await fetch(url);
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

function toNullableFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveExpectedVolumeProfile(feeTvlRatio) {
  const ratio = Math.max(0, toFiniteNumber(feeTvlRatio, 0));
  if (ratio >= 0.08) return "high";
  if (ratio >= 0.03) return "balanced";
  if (ratio <= 0.01) return "low";
  return "balanced";
}

function inferTrendBiasFromBins(lowerBin, upperBin, activeBin) {
  if (!Number.isFinite(lowerBin) || !Number.isFinite(upperBin) || !Number.isFinite(activeBin)) {
    return "neutral";
  }
  if (activeBin > upperBin) return "bullish";
  if (activeBin < lowerBin) return "bearish";

  const span = upperBin - lowerBin;
  if (span <= 0) return "neutral";
  const ratio = (activeBin - lowerBin) / span;
  if (ratio >= 0.6) return "bullish";
  if (ratio <= 0.4) return "bearish";
  return "neutral";
}

function classifyRangeLocation({ lowerBin, upperBin, activeBin }) {
  if (!Number.isFinite(lowerBin) || !Number.isFinite(upperBin) || !Number.isFinite(activeBin)) {
    return {
      location: "unknown",
      in_range: null,
      normalized_position: null,
      distance_to_lower_bins: null,
      distance_to_upper_bins: null,
    };
  }

  if (upperBin <= lowerBin) {
    return {
      location: "unknown",
      in_range: null,
      normalized_position: null,
      distance_to_lower_bins: null,
      distance_to_upper_bins: null,
    };
  }

  if (activeBin < lowerBin) {
    return {
      location: "out_below",
      in_range: false,
      normalized_position: roundMetric((activeBin - lowerBin) / (upperBin - lowerBin), 4),
      distance_to_lower_bins: activeBin - lowerBin,
      distance_to_upper_bins: upperBin - activeBin,
    };
  }

  if (activeBin > upperBin) {
    return {
      location: "out_above",
      in_range: false,
      normalized_position: roundMetric((activeBin - lowerBin) / (upperBin - lowerBin), 4),
      distance_to_lower_bins: activeBin - lowerBin,
      distance_to_upper_bins: upperBin - activeBin,
    };
  }

  const span = upperBin - lowerBin;
  const ratio = (activeBin - lowerBin) / span;
  const location = ratio <= 0.33 ? "near_lower" : ratio >= 0.67 ? "near_upper" : "near_center";

  return {
    location,
    in_range: true,
    normalized_position: roundMetric(ratio, 4),
    distance_to_lower_bins: activeBin - lowerBin,
    distance_to_upper_bins: upperBin - activeBin,
  };
}

function roundAmount(value, decimals = 6) {
  const sanitized = Math.max(0, toFiniteNumber(value, 0));
  const factor = Math.pow(10, decimals);
  return Math.floor(sanitized * factor) / factor;
}

function findTokenBalanceByMint(walletBalances, mint) {
  if (!mint || !walletBalances || !Array.isArray(walletBalances.tokens)) return null;
  const normalizedMint = normalizeMint(mint);
  return walletBalances.tokens.find((token) => normalizeMint(token.mint) === normalizedMint) || null;
}

function getWalletBalanceByMint(walletBalances, mint) {
  const normalizedMint = normalizeMint(mint);
  if (normalizedMint === config.tokens.SOL) {
    return toNullableFiniteNumber(walletBalances?.sol);
  }

  const token = findTokenBalanceByMint(walletBalances, normalizedMint);
  if (!token) return 0;
  return toNullableFiniteNumber(token.balance);
}

async function captureBalanceSnapshotForMints({ token_x_mint, token_y_mint, phase }) {
  const balances = await getWalletBalances();
  if (balances?.error) {
    return {
      error: `Unable to load wallet balances ${phase}: ${balances.error}`,
    };
  }

  const tokenXAmount = getWalletBalanceByMint(balances, token_x_mint);
  const tokenYAmount = getWalletBalanceByMint(balances, token_y_mint);

  if (tokenXAmount == null || tokenYAmount == null) {
    return {
      error: `Unable to read token balances ${phase} for pool token mints`,
    };
  }

  return {
    token_x_mint: normalizeMint(token_x_mint),
    token_y_mint: normalizeMint(token_y_mint),
    amount_x: tokenXAmount,
    amount_y: tokenYAmount,
    sampled_at: new Date().toISOString(),
  };
}

function calculateBalanceDeltas(beforeSnapshot, afterSnapshot) {
  if (!beforeSnapshot || !afterSnapshot) {
    return { error: "Cannot compute balance deltas without before/after snapshots" };
  }

  const deltaXRaw = toNullableFiniteNumber(afterSnapshot.amount_x - beforeSnapshot.amount_x);
  const deltaYRaw = toNullableFiniteNumber(afterSnapshot.amount_y - beforeSnapshot.amount_y);

  if (deltaXRaw == null || deltaYRaw == null) {
    return { error: "Computed non-finite balance deltas" };
  }

  const amountX = roundAmount(Math.max(0, deltaXRaw), 6);
  const amountY = roundAmount(Math.max(0, deltaYRaw), 6);

  if (amountX <= 0 && amountY <= 0) {
    return {
      error: "No positive recovered token deltas detected after close",
      delta_x_raw: roundMetric(deltaXRaw, 8),
      delta_y_raw: roundMetric(deltaYRaw, 8),
    };
  }

  return {
    amount_x: amountX,
    amount_y: amountY,
    delta_x_raw: roundMetric(deltaXRaw, 8),
    delta_y_raw: roundMetric(deltaYRaw, 8),
  };
}

function resolveBinSnapshot(position, pnl) {
  const lowerBin = toNullableFiniteNumber(pnl?.lower_bin) ?? toNullableFiniteNumber(position?.lower_bin);
  const upperBin = toNullableFiniteNumber(pnl?.upper_bin) ?? toNullableFiniteNumber(position?.upper_bin);
  const activeBin = toNullableFiniteNumber(pnl?.active_bin) ?? toNullableFiniteNumber(position?.active_bin);
  const inRange = typeof pnl?.in_range === "boolean"
    ? pnl.in_range
    : typeof position?.in_range === "boolean"
      ? position.in_range
      : null;

  return { lowerBin, upperBin, activeBin, inRange };
}

function buildPoolPlanningData(position, binSnapshot) {
  const observedWidth = Number.isFinite(binSnapshot.lowerBin) && Number.isFinite(binSnapshot.upperBin)
    ? Math.max(2, Math.abs(binSnapshot.upperBin - binSnapshot.lowerBin) / 3)
    : 8;

  const sixHourVolatility = roundMetric(
    Math.max(0, toFiniteNumber(position?.volatility, observedWidth)),
    2
  );
  const trendBias = inferTrendBiasFromBins(binSnapshot.lowerBin, binSnapshot.upperBin, binSnapshot.activeBin);
  const syntheticPriceChange = trendBias === "bullish" ? 12 : trendBias === "bearish" ? -12 : 0;
  const feeTvlRatio = Math.max(0, toFiniteNumber(position?.fee_tvl_ratio, 0));

  return {
    pool_data: {
      six_hour_volatility: sixHourVolatility,
      fee_tvl_ratio: feeTvlRatio,
      organic_score: Math.max(0, toFiniteNumber(position?.organic_score, 0)),
      bin_step: Math.max(0, toFiniteNumber(position?.bin_step, 0)),
      price_change_pct: syntheticPriceChange,
      active_tvl: Math.max(0, toFiniteNumber(position?.total_value_usd, 0)),
      volume_24h: Math.max(0, toFiniteNumber(position?.volume_24h, 0)),
    },
    trend_bias: trendBias,
    expected_volume_profile: resolveExpectedVolumeProfile(feeTvlRatio),
  };
}

async function resolvePoolTokenMints(poolAddress) {
  if (!poolAddress) return null;
  try {
    const pool = await getPool(poolAddress);
    return {
      token_x_mint: pool?.lbPair?.tokenXMint?.toString() || null,
      token_y_mint: pool?.lbPair?.tokenYMint?.toString() || null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

function buildTrackedPositionFallback(position_address) {
  const tracked = getTrackedPosition(position_address);
  if (!tracked || tracked.closed) return null;

  return {
    position: tracked.position,
    pool: tracked.pool,
    pair: tracked.pool_name || tracked.pool?.slice(0, 8) || null,
    pool_name: tracked.pool_name || null,
    strategy: tracked.strategy || null,
    bin_step: tracked.bin_step ?? null,
    volatility: tracked.volatility ?? null,
    fee_tvl_ratio: tracked.fee_tvl_ratio ?? null,
    organic_score: tracked.organic_score ?? null,
    lower_bin: tracked.bin_range?.min ?? null,
    upper_bin: tracked.bin_range?.max ?? null,
    active_bin: tracked.active_bin_at_deploy ?? null,
    in_range: tracked.out_of_range_since ? false : true,
    unclaimed_fees_usd: 0,
    total_value_usd: tracked.initial_value_usd ?? 0,
    source: "state_fallback",
  };
}

async function getPositionExecutionContext(position_address) {
  const isDryRun = process.env.DRY_RUN === "true";
  const positionsResult = await getMyPositions({ force: true });
  if (positionsResult?.error) {
    if (isDryRun) {
      const fallbackPosition = buildTrackedPositionFallback(position_address);
      if (fallbackPosition) {
        const binSnapshot = resolveBinSnapshot(fallbackPosition, null);
        const rangeLocation = classifyRangeLocation(binSnapshot);
        return {
          position: fallbackPosition,
          pnl: null,
          bin_snapshot: binSnapshot,
          range_location: rangeLocation,
          in_range: binSnapshot.inRange,
          context_source: "state_fallback",
        };
      }
    }
    return {
      error: `Unable to load open positions: ${positionsResult.error}`,
      positions: positionsResult.positions || [],
    };
  }

  const position = (positionsResult.positions || []).find((item) => item.position === position_address);
  if (!position) {
    if (isDryRun) {
      const fallbackPosition = buildTrackedPositionFallback(position_address);
      if (fallbackPosition) {
        const binSnapshot = resolveBinSnapshot(fallbackPosition, null);
        const rangeLocation = classifyRangeLocation(binSnapshot);
        return {
          position: fallbackPosition,
          pnl: null,
          bin_snapshot: binSnapshot,
          range_location: rangeLocation,
          in_range: binSnapshot.inRange,
          context_source: "state_fallback",
        };
      }
    }
    return {
      error: `Position ${position_address} was not found in open positions`,
      positions: positionsResult.positions || [],
    };
  }

  let pnl = null;
  try {
    pnl = await getPositionPnl({ pool_address: position.pool, position_address });
  } catch (error) {
    pnl = { error: error.message };
  }

  const binSnapshot = resolveBinSnapshot(position, pnl);
  const rangeLocation = classifyRangeLocation(binSnapshot);

  return {
    position,
    pnl,
    bin_snapshot: binSnapshot,
    range_location: rangeLocation,
    in_range: binSnapshot.inRange,
  };
}

export async function rebalanceOnExit({
  position_address,
  force_rebalance = false,
  expected_volume_profile,
  execute = true,
} = {}) {
  position_address = normalizeMint(position_address);
  if (!position_address) {
    return { success: false, error: "position_address is required" };
  }

  const context = await getPositionExecutionContext(position_address);
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

  const poolTokenMints = await resolvePoolTokenMints(context.position.pool);
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
  });
  if (beforeCloseSnapshot?.error) {
    return {
      success: false,
      error: `Cannot execute live rebalance without a pre-close balance snapshot: ${beforeCloseSnapshot.error}`,
      position: position_address,
      action_plan: actionPlan,
    };
  }

  const closeResult = await closePosition({ position_address });
  if (!closeResult?.success) {
    return {
      success: false,
      error: closeResult?.error || "Failed to close position for rebalance",
      position: position_address,
      close_result: closeResult,
      action_plan: actionPlan,
    };
  }

  const afterCloseSnapshot = await captureBalanceSnapshotForMints({
    token_x_mint: poolTokenMints.token_x_mint,
    token_y_mint: poolTokenMints.token_y_mint,
    phase: "after close",
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
  };
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

function resolveCompoundingBias(rangeLocation) {
  if (rangeLocation.location === "near_upper" || rangeLocation.location === "out_above") {
    return "quote_heavy";
  }
  if (rangeLocation.location === "near_lower" || rangeLocation.location === "out_below") {
    return "base_heavy";
  }
  return "balanced";
}

function normalizeCompoundingLocation(rangeLocation) {
  if (rangeLocation.location === "near_upper" || rangeLocation.location === "out_above") {
    return "near_upper";
  }
  if (rangeLocation.location === "near_lower" || rangeLocation.location === "out_below") {
    return "near_lower";
  }
  return "near_center";
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

  const context = await getPositionExecutionContext(position_address);
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

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address }) {
  position_address = normalizeMint(position_address);
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
    recordClose(position_address, "agent decision");

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
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
      if (cachedPos) {
        pnlUsd        = cachedPos.pnl_usd   ?? 0;
        pnlPct        = cachedPos.pnl_pct   ?? 0;
        finalValueUsd = cachedPos.total_value_usd ?? 0;
        feesUsd       = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
      }

      _positionsCacheAt = 0; // invalidate cache after snapshotting PnL
      const initialUsd = tracked.initial_value_usd || 0;

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: "agent decision",
      });

      return { success: true, position: position_address, pool: poolAddress, pool_name: tracked.pool_name || null, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct, base_mint: pool.lbPair.tokenXMint.toString() };
    }

    return { success: true, position: position_address, pool: poolAddress, pool_name: null, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
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
