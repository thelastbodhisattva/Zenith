import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { log } from "../logger.js";
import { evaluateExposureAdmission } from "../runtime-policy.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const DISCOVERY_CACHE_TTL_MS = 15 * 1000;

const discoveryCache = new Map();

function getDiscoveryCacheKey({ page_size, timeframe, category, screeningFingerprint }) {
  return JSON.stringify({ page_size, timeframe, category, screeningFingerprint });
}

export function resetDiscoveryCache() {
  discoveryCache.clear();
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
  timeframe,
  category,
  screeningConfig,
  force = false,
} = {}) {
  const s = screeningConfig || config.screening;
  const resolvedTimeframe = timeframe ?? s.timeframe;
  const resolvedCategory = category ?? s.category;
  const screeningFingerprint = [
    s.minMcap,
    s.maxMcap,
    s.minHolders,
    s.minVolume,
    s.minTvl,
    s.maxTvl,
    s.minBinStep,
    s.maxBinStep,
    s.minFeeActiveTvlRatio,
    s.minOrganic,
  ].join("|");
  const cacheKey = getDiscoveryCacheKey({
    page_size,
    timeframe: resolvedTimeframe,
    category: resolvedCategory,
    screeningFingerprint,
  });
  const cached = discoveryCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.cachedAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.value;
  }

  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${resolvedTimeframe}` +
    `&category=${resolvedCategory}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Filter blacklisted base tokens
  const pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) {
    log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens`);
  }

  const result = {
    total: data.total,
    pools,
  };

  discoveryCache.set(cacheKey, {
    cachedAt: Date.now(),
    value: result,
  });

  return result;
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({
  limit = 10,
  pools,
  discoverPoolsFn,
  getMyPositionsFn,
  screeningConfig,
  evaluationContext,
} = {}) {
  const discover = discoverPoolsFn || discoverPools;
  const resolvedPools = Array.isArray(pools)
    ? pools
    : (await discover({ page_size: 50, screeningConfig })).pools;

  // Exclude pools where the wallet already has an open position
  const readPositions = getMyPositionsFn || (await import("./dlmm.js")).getMyPositions;
  const positionsResult = await readPositions();
  if (!positionsResult || typeof positionsResult !== "object") {
    throw new Error("positions unavailable");
  }
  if (positionsResult.error) {
    throw new Error(`positions unavailable: ${positionsResult.error}`);
  }
  if (!Array.isArray(positionsResult.positions)) {
    throw new Error("positions payload missing positions array");
  }
  const { positions } = positionsResult;
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const { candidates, blocked_summary, total_eligible } = rankCandidateSnapshots(resolvedPools, {
    occupiedPools,
    occupiedMints,
    limit,
    screeningConfig,
    evaluationContext,
  });

  return {
    candidates,
    total_screened: resolvedPools.length,
    total_eligible,
    blocked_summary,
    occupied_pools: Array.from(occupiedPools),
    occupied_mints: Array.from(occupiedMints),
    candidate_inputs: resolvedPools,
  };
}

export function rankCandidateSnapshots(pools, {
  occupiedPools = new Set(),
  occupiedMints = new Set(),
  limit = 10,
  screeningConfig,
  evaluationContext,
} = {}) {
  const evaluations = pools.map((pool) => evaluateCandidateSnapshot(pool, {
    occupiedPools,
    occupiedMints,
    screeningConfig,
    evaluationContext,
  }));
  const blocked_summary = summarizeBlockedCandidates(evaluations);
  const candidates = evaluations
    .filter((pool) => pool.eligible)
    .sort(compareCandidateScores)
    .slice(0, limit)
    .map((pool, index) => ({
      ...pool,
      score_rank: index + 1,
    }));

  return {
    candidates,
    total_eligible: evaluations.filter((pool) => pool.eligible).length,
    blocked_summary,
    evaluations,
  };
}

export function evaluateCandidateSnapshot(pool, {
  occupiedPools = new Set(),
  occupiedMints = new Set(),
  screeningConfig,
  evaluationContext,
} = {}) {
  const s = screeningConfig || config.screening;
  const hard_blocks = [];
  const token_age_hours = asTokenAgeHours(pool.token_age_hours);
  const minTokenAgeHours = asOptionalTokenAgeThreshold(s.minTokenAgeHours);
  const maxTokenAgeHours = asOptionalTokenAgeThreshold(s.maxTokenAgeHours);
  const tokenTooNew = token_age_hours != null && minTokenAgeHours != null && token_age_hours < minTokenAgeHours;
  const tokenTooOld = token_age_hours != null && maxTokenAgeHours != null && token_age_hours > maxTokenAgeHours;
  const gate_results = {
    pool_unoccupied: !occupiedPools.has(pool.pool),
    token_unoccupied: !pool.base?.mint || !occupiedMints.has(pool.base.mint),
    not_blacklisted: !isBlacklisted(pool.base?.mint),
    token_age_available: token_age_hours != null,
    token_age_min_ok: minTokenAgeHours == null || token_age_hours == null || token_age_hours >= minTokenAgeHours,
    token_age_max_ok: maxTokenAgeHours == null || token_age_hours == null || token_age_hours <= maxTokenAgeHours,
  };

  const exposure = evaluateExposureAdmission({
    poolAddress: pool.pool,
    baseMint: pool.base?.mint,
    occupiedPools,
    occupiedMints,
  });
  if (!exposure.pass && Array.isArray(exposure.hard_blocks)) hard_blocks.push(...exposure.hard_blocks);
  if (!gate_results.not_blacklisted) hard_blocks.push("base_token_blacklisted");
  if (tokenTooNew) hard_blocks.push("token_too_new");
  if (tokenTooOld) hard_blocks.push("token_too_old");

  const extraPolicy = typeof evaluationContext?.extraHardBlockFn === "function"
    ? evaluationContext.extraHardBlockFn(pool)
    : null;
  if (extraPolicy?.blocked && extraPolicy.reason) {
    hard_blocks.push(extraPolicy.reason);
  }

  const score_breakdown = buildCandidateScore(pool, s);
  const penalty = Number(extraPolicy?.penalty_score || 0);
  const deterministic_score = round2(Math.max(0, score_breakdown.total_score - Math.max(0, penalty)));

  return {
    ...pool,
    token_age_hours,
    eligible: hard_blocks.length === 0,
    eligibility_reason: hard_blocks[0] || "eligible",
    hard_blocks,
    gate_results,
    deterministic_score,
    score_breakdown,
    extra_policy: extraPolicy || null,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Token age visibility from discovery payload (ms epoch)
    token_age_hours: toTokenAgeHours(p.token_x?.created_at),

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function buildCandidateScore(pool, screeningConfig) {
  const feeEfficiency = normalizeFloor(pool.fee_active_tvl_ratio, screeningConfig.minFeeActiveTvlRatio, 4);
  const volume = normalizeFloor(pool.volume_window, screeningConfig.minVolume, 20);
  const organic = normalizeRange(pool.organic_score, screeningConfig.minOrganic, 100);
  const holderDepth = normalizeFloor(pool.holders, screeningConfig.minHolders, 4);
  const activeLiquidity = clamp01((pool.active_pct ?? 0) / 100);
  const volatilityFit = scoreVolatility(pool.volatility);

  const weighted = {
    fee_efficiency: round2(feeEfficiency * 30),
    volume: round2(volume * 20),
    organic: round2(organic * 20),
    holder_depth: round2(holderDepth * 10),
    active_liquidity: round2(activeLiquidity * 10),
    volatility_fit: round2(volatilityFit * 10),
  };

  const total_score = round2(Object.values(weighted).reduce((sum, value) => sum + value, 0));

  return {
    total_score,
    components: weighted,
    raw_inputs: {
      fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
      volume_window: pool.volume_window,
      organic_score: pool.organic_score,
      holders: pool.holders,
      active_pct: pool.active_pct,
      volatility: pool.volatility,
    },
  };
}

function toTokenAgeHours(createdAtMs) {
  const created = Number(createdAtMs);
  if (!Number.isFinite(created) || created <= 0) return null;
  const ageMs = Date.now() - created;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return fix(ageMs / 3_600_000, 2);
}

function asTokenAgeHours(value) {
  const age = Number(value);
  if (!Number.isFinite(age) || age < 0) return null;
  return age;
}

function asOptionalTokenAgeThreshold(value) {
  if (value == null || value === "") return null;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) return null;
  return threshold;
}

function summarizeBlockedCandidates(pools) {
  const summary = {};

  for (const pool of pools) {
    for (const reason of pool.hard_blocks || []) {
      summary[reason] = (summary[reason] || 0) + 1;
    }
  }

  return summary;
}

function compareCandidateScores(a, b) {
  if (b.deterministic_score !== a.deterministic_score) return b.deterministic_score - a.deterministic_score;
  if ((b.organic_score ?? 0) !== (a.organic_score ?? 0)) return (b.organic_score ?? 0) - (a.organic_score ?? 0);
  return (b.volume_window ?? 0) - (a.volume_window ?? 0);
}

function normalizeFloor(value, floor, stretchMultiplier) {
  const num = Number(value);
  const min = Number(floor);
  const cap = min * stretchMultiplier;

  if (!Number.isFinite(num) || !Number.isFinite(min) || min <= 0) return 0;
  return clamp01(num / cap);
}

function normalizeRange(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= min) return 0;
  if (num >= max) return 1;
  return clamp01((num - min) / Math.max(1, max - min));
}

function scoreVolatility(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.25;
  if (num <= 2) return 0.55;
  if (num <= 6) return 1;
  if (num <= 12) return 0.75;
  if (num <= 18) return 0.45;
  return 0.2;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round2(value) {
  return Number(value.toFixed(2));
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}
