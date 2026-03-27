/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";

const POOL_MEMORY_FILE = "./pool-memory.json";
const LOW_YIELD_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const NEGATIVE_REGIME_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_REGIME_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
export const CANONICAL_LOW_YIELD_REASON = "fee yield too low";

function createPoolEntry(name, baseMint = null) {
  return {
    name,
    base_mint: baseMint,
    deploys: [],
    total_deploys: 0,
    avg_pnl_pct: 0,
    win_rate: 0,
    last_deployed_at: null,
    last_outcome: null,
    notes: [],
    snapshots: [],
    token_type_distribution_stats: {},
    low_yield_cooldown_until: null,
    low_yield_cooldown_reason: null,
    negative_regime_cooldowns: {},
  };
}

function ensurePoolEntry(db, poolAddress, seed = {}) {
  if (!db[poolAddress]) {
    db[poolAddress] = createPoolEntry(seed.name || poolAddress.slice(0, 8), seed.base_mint || null);
  }

  if (!db[poolAddress].notes) db[poolAddress].notes = [];
  if (!db[poolAddress].deploys) db[poolAddress].deploys = [];
  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];
  if (!db[poolAddress].token_type_distribution_stats) db[poolAddress].token_type_distribution_stats = {};
  if (!Object.hasOwn(db[poolAddress], "low_yield_cooldown_until")) db[poolAddress].low_yield_cooldown_until = null;
  if (!Object.hasOwn(db[poolAddress], "low_yield_cooldown_reason")) db[poolAddress].low_yield_cooldown_reason = null;
  if (!db[poolAddress].negative_regime_cooldowns || typeof db[poolAddress].negative_regime_cooldowns !== "object") {
    db[poolAddress].negative_regime_cooldowns = {};
  }
  if (!db[poolAddress].name) db[poolAddress].name = seed.name || poolAddress.slice(0, 8);
  if (!db[poolAddress].base_mint && seed.base_mint) db[poolAddress].base_mint = seed.base_mint;
  return db[poolAddress];
}

export function buildNegativeRegimeCooldownKey({ regime_label, strategy }) {
  const regime = String(regime_label || "neutral").trim().toLowerCase() || "neutral";
  const strategyName = String(strategy || "unknown").trim().toLowerCase() || "unknown";
  return `${regime}|${strategyName}`;
}

function shouldRecordNegativeRegimeCooldown(deploy) {
  const pnlPct = Number(deploy.pnl_pct);
  if (Number.isFinite(pnlPct) && pnlPct <= -5) return true;

  const reason = normalizeReason(deploy.close_reason);
  return reason.includes("stop loss") || reason.includes("fee yield too low") || reason.includes("volume collapse");
}

function recordNegativeRegimeCooldown(entry, deploy, nowMs = Date.now()) {
  if (!shouldRecordNegativeRegimeCooldown(deploy)) return;

  const key = buildNegativeRegimeCooldownKey({
    regime_label: deploy.regime_label,
    strategy: deploy.strategy,
  });

  const existing = entry.negative_regime_cooldowns[key];
  const existingHits = Number(existing?.hits) || 0;
  const nextHits = Math.max(1, existingHits + 1);
  const durationMs = Math.min(
    NEGATIVE_REGIME_COOLDOWN_MAX_MS,
    NEGATIVE_REGIME_COOLDOWN_MS + ((nextHits - 1) * 2 * 60 * 60 * 1000),
  );

  entry.negative_regime_cooldowns[key] = {
    key,
    regime_label: deploy.regime_label || "neutral",
    strategy: deploy.strategy || "unknown",
    hits: nextHits,
    cooldown_until: new Date(nowMs + durationMs).toISOString(),
    reason: `negative outcome: ${deploy.close_reason || "loss"}`,
    last_recorded_at: deploy.closed_at || new Date(nowMs).toISOString(),
    last_pnl_pct: Number.isFinite(Number(deploy.pnl_pct)) ? Number(deploy.pnl_pct) : null,
  };
}

export function getNegativeRegimeCooldown({
  pool_address,
  regime_label = "neutral",
  strategy,
  nowMs = Date.now(),
} = {}) {
  if (!pool_address) {
    return {
      pool_address: null,
      key: null,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
      hits: 0,
    };
  }

  const db = load();
  const entry = db[pool_address];
  if (!entry?.negative_regime_cooldowns) {
    return {
      pool_address,
      key: null,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
      hits: 0,
    };
  }

  const key = buildNegativeRegimeCooldownKey({ regime_label, strategy });
  const cooldown = entry.negative_regime_cooldowns[key];
  if (!cooldown?.cooldown_until) {
    return {
      pool_address,
      key,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
      hits: 0,
    };
  }

  const cooldownUntilMs = Date.parse(cooldown.cooldown_until);
  if (!Number.isFinite(cooldownUntilMs)) {
    return {
      pool_address,
      key,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
      hits: Number(cooldown.hits) || 0,
    };
  }

  const remainingMs = Math.max(0, cooldownUntilMs - nowMs);
  return {
    pool_address,
    key,
    active: remainingMs > 0,
    cooldown_until: cooldown.cooldown_until,
    remaining_ms: remainingMs,
    reason: cooldown.reason || "negative regime cooldown",
    hits: Number(cooldown.hits) || 0,
  };
}

function normalizeReason(reason) {
  return String(reason || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isLowYieldCloseReason(reason) {
  const normalized = normalizeReason(reason);
  if (!normalized) return false;
  return normalized === CANONICAL_LOW_YIELD_REASON || normalized === "low yield";
}

export function getPoolDeployCooldown({ pool_address, nowMs = Date.now() } = {}) {
  if (!pool_address) {
    return {
      pool_address: null,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
    };
  }

  const db = load();
  const entry = db[pool_address];
  if (!entry?.low_yield_cooldown_until) {
    return {
      pool_address,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
    };
  }

  const cooldownUntilMs = Date.parse(entry.low_yield_cooldown_until);
  if (!Number.isFinite(cooldownUntilMs)) {
    return {
      pool_address,
      active: false,
      cooldown_until: null,
      remaining_ms: 0,
      reason: null,
    };
  }

  const remainingMs = Math.max(0, cooldownUntilMs - nowMs);
  return {
    pool_address,
    active: remainingMs > 0,
    cooldown_until: entry.low_yield_cooldown_until,
    remaining_ms: remainingMs,
    reason: entry.low_yield_cooldown_reason || CANONICAL_LOW_YIELD_REASON,
  };
}

function round(value, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function updateTokenTypeDistributionStats(entry, deploy) {
  const key = deploy.token_type_distribution;
  if (!key) return;

  const stats = entry.token_type_distribution_stats[key] || {
    distribution_key: key,
    total_closed: 0,
    wins: 0,
    losses: 0,
    avg_pnl_pct: 0,
    avg_fee_yield_pct: 0,
    last_outcome: null,
    last_recorded_at: null,
  };

  stats.total_closed += 1;
  if ((deploy.pnl_pct ?? 0) >= 0) stats.wins += 1;
  else stats.losses += 1;

  if (typeof deploy.pnl_pct === "number" && Number.isFinite(deploy.pnl_pct)) {
    stats.avg_pnl_pct = round(((stats.avg_pnl_pct || 0) * (stats.total_closed - 1) + deploy.pnl_pct) / stats.total_closed, 2);
  }

  if (typeof deploy.fee_yield_pct === "number" && Number.isFinite(deploy.fee_yield_pct)) {
    stats.avg_fee_yield_pct = round(((stats.avg_fee_yield_pct || 0) * (stats.total_closed - 1) + deploy.fee_yield_pct) / stats.total_closed, 2);
  }

  stats.win_rate = round((stats.wins / stats.total_closed) * 100, 2);
  stats.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
  stats.last_recorded_at = deploy.closed_at || new Date().toISOString();

  entry.token_type_distribution_stats[key] = stats;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 * @param {number} deployData.fee_yield_pct
 * @param {string} deployData.token_type_distribution
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();
  const entry = ensurePoolEntry(db, poolAddress, {
    name: deployData.pool_name || poolAddress.slice(0, 8),
    base_mint: deployData.base_mint || null,
  });

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    fee_yield_pct: deployData.fee_yield_pct ?? null,
    token_type_distribution: deployData.token_type_distribution || null,
    regime_label: deployData.regime_label || "neutral",
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  updateTokenTypeDistributionStats(entry, deploy);

  if (isLowYieldCloseReason(deploy.close_reason)) {
    entry.low_yield_cooldown_until = new Date(Date.now() + LOW_YIELD_COOLDOWN_MS).toISOString();
    entry.low_yield_cooldown_reason = CANONICAL_LOW_YIELD_REASON;
  }

  recordNegativeRegimeCooldown(entry, deploy);

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    notes: entry.notes,
    token_type_distribution_stats: entry.token_type_distribution_stats || {},
    negative_regime_cooldowns: entry.negative_regime_cooldowns || {},
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();
  const entry = ensurePoolEntry(db, poolAddress, {
    name: snapshot.pair || poolAddress.slice(0, 8),
  });

  entry.snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (entry.snapshots.length > 48) {
    entry.snapshots = entry.snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    lines.push(`NOTE: ${lastNote.note}`);
  }

  const distributionStats = Object.values(entry.token_type_distribution_stats || {})
    .sort((a, b) => (b.total_closed || 0) - (a.total_closed || 0));
  if (distributionStats.length > 0) {
    const best = distributionStats[0];
    lines.push(`DISTRIBUTION MEMORY: ${best.distribution_key} win rate ${best.win_rate}% over ${best.total_closed} close(s), avg PnL ${best.avg_pnl_pct}%`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  if (!note) return { error: "note required" };

  const db = load();
  const entry = ensurePoolEntry(db, pool_address, {
    name: pool_address.slice(0, 8),
  });

  entry.notes.push({
    note,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${note}`);
  return { saved: true, pool_address, note };
}
