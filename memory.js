import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVE_DIR = process.env.ZENITH_MEMORY_DIR || path.join(__dirname, "data", "nuggets");
const DEFAULT_NUGGETS = ["strategies", "lessons", "patterns", "facts", "wallet_scores", "distribution_stats"];

let shelf = null;

function ensureDir() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
}

function sanitizeKey(str) {
  return String(str || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 40);
}

function tokenize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function nuggetPath(name) {
  return path.join(SAVE_DIR, `${name}.json`);
}

function loadNugget(name) {
  const file = nuggetPath(name);
  if (!fs.existsSync(file)) return { name, facts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      name,
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact).filter(Boolean) : [],
    };
  } catch {
    return { name, facts: [] };
  }
}

function saveNugget(nugget) {
  ensureDir();
  fs.writeFileSync(nuggetPath(nugget.name), JSON.stringify(nugget, null, 2));
}

function normalizeFact(fact) {
  if (!fact || typeof fact !== "object") return null;

  const safeKey = sanitizeKey(fact.key);
  if (!safeKey) return null;

  const now = new Date().toISOString();
  return {
    key: safeKey,
    value: String(fact.value || "").slice(0, 400),
    hits: Number.isFinite(fact.hits) ? fact.hits : 0,
    created_at: fact.created_at || now,
    updated_at: fact.updated_at || fact.created_at || now,
    tags: Array.isArray(fact.tags) ? fact.tags.filter(Boolean).slice(0, 12) : [],
    data: fact.data && typeof fact.data === "object" ? fact.data : null,
  };
}

function upsertFact(nuggetName, key, value, options = {}) {
  const store = getShelf();
  const nugget = store.getOrCreate(nuggetName);
  const safeKey = sanitizeKey(key);
  const factValue = String(value || "").slice(0, 400);
  const now = new Date().toISOString();
  const tags = Array.isArray(options.tags) ? options.tags.filter(Boolean).slice(0, 12) : [];
  const data = options.data && typeof options.data === "object" ? options.data : null;
  const existing = nugget.facts.find((fact) => fact.key === safeKey);

  if (existing) {
    existing.value = factValue;
    existing.updated_at = now;
    if (options.tags !== undefined) existing.tags = tags;
    if (options.data !== undefined) existing.data = data;
  } else {
    nugget.facts.push({
      key: safeKey,
      value: factValue,
      hits: 0,
      created_at: now,
      updated_at: now,
      tags,
      data,
    });
  }

  saveNugget(nugget);
  return safeKey;
}

function getFactByKey(nuggetName, key) {
  const nugget = getShelf().getOrCreate(nuggetName);
  const safeKey = sanitizeKey(key);
  return {
    nugget,
    fact: nugget.facts.find((entry) => entry.key === safeKey) || null,
  };
}

function round(value, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getBinStepBucket(binStep) {
  const value = Number(binStep);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 90) return "tight";
  if (value <= 110) return "standard";
  return "wide";
}

export function buildStrategyMemoryKey(strategy, binStep = null) {
  return sanitizeKey(`strategy-${String(strategy || "unknown").toLowerCase()}-${getBinStepBucket(binStep)}`);
}

function buildLegacyStrategyMemoryKey(strategy, binStep = null) {
  return sanitizeKey(`${String(strategy || "unknown").toLowerCase()}_bs${binStep}`);
}

function scoreFact(fact, query) {
  const rawQuery = String(query || "").toLowerCase();
  const queryTokens = tokenize(query);
  const haystack = `${fact.key} ${fact.value}`.toLowerCase();

  if (!rawQuery || !haystack) return 0;
  if (fact.key.toLowerCase() === rawQuery) return 1;
  if (haystack.includes(rawQuery)) return 0.92;

  const factTokens = new Set(tokenize(haystack));
  const overlap = queryTokens.filter((token) => factTokens.has(token)).length;
  if (!queryTokens.length || overlap === 0) return 0;
  return overlap / queryTokens.length;
}

function recallBest(query, nuggetName = null) {
  const store = getShelf();
  const nuggets = nuggetName
    ? [store.getOrCreate(nuggetName)]
    : [...store.list()].map(({ name }) => store.get(name));

  let best = null;

  for (const nugget of nuggets) {
    for (const fact of nugget.facts) {
      const confidence = scoreFact(fact, query);
      if (confidence < 0.34) continue;
      if (!best || confidence > best.confidence) {
        best = { nugget, fact, confidence };
      }
    }
  }

  if (!best) {
    return { found: false, query, nugget: nuggetName || null };
  }

  best.fact.hits = (best.fact.hits || 0) + 1;
  best.fact.updated_at = new Date().toISOString();
  saveNugget(best.nugget);

  return {
    found: true,
    nugget: best.nugget.name,
    key: best.fact.key,
    answer: best.fact.value,
    confidence: Math.round(best.confidence * 100) / 100,
    hits: best.fact.hits,
  };
}

export function initMemory() {
  ensureDir();
  const nuggets = new Map();
  for (const name of DEFAULT_NUGGETS) nuggets.set(name, loadNugget(name));

  shelf = {
    nuggets,
    getOrCreate(name) {
      if (!this.nuggets.has(name)) {
        const nugget = loadNugget(name);
        this.nuggets.set(name, nugget);
        saveNugget(nugget);
      }
      return this.nuggets.get(name);
    },
    get(name) {
      return this.getOrCreate(name);
    },
    list() {
      return [...this.nuggets.keys()].map((name) => ({ name }));
    },
    get size() {
      return this.nuggets.size;
    },
  };

  log("memory", `Memory initialized (${shelf.size} nuggets loaded from ${SAVE_DIR})`);
  return shelf;
}

export function getShelf() {
  if (!shelf) initMemory();
  return shelf;
}

export function rememberStrategy(pattern, result) {
  const key = typeof pattern === "object" && pattern !== null
    ? buildStrategyMemoryKey(pattern.strategy, pattern.bin_step)
    : sanitizeKey(pattern);
  upsertFact("strategies", key, typeof result === "string" ? result : JSON.stringify(result));
  log("memory", `Remembered strategy: ${key}`);
}

export function recallForScreening(poolData) {
  const results = [];

  if (poolData?.bin_step) {
    for (const strategy of ["bid_ask", "spot"]) {
      const keysToTry = [
        buildStrategyMemoryKey(strategy, poolData.bin_step),
        buildLegacyStrategyMemoryKey(strategy, poolData.bin_step),
      ];

      for (const key of keysToTry) {
        const hit = recallBest(key, "strategies");
        if (hit.found && !results.some((result) => result.key === hit.key)) {
          results.push({ source: "strategies", ...hit });
          break;
        }
      }
    }
  }

  return results.slice(0, 2);
}

export function recallForManagement(position) {
  const results = [];

  if (position?.strategy && position?.bin_step != null) {
    const keysToTry = [
      buildStrategyMemoryKey(position.strategy, position.bin_step),
      buildLegacyStrategyMemoryKey(position.strategy, position.bin_step),
    ];
    for (const key of keysToTry) {
      const hit = recallBest(key, "strategies");
      if (hit.found) {
        results.push({ source: "strategies", ...hit });
        break;
      }
    }
  }

  const lessonHit = recallBest("management", "lessons");
  if (lessonHit.found) results.push({ source: "lessons", ...lessonHit });

  return results;
}

export function getMemoryContext() {
  const store = getShelf();
  const facts = [];

  for (const { name } of store.list()) {
    const nugget = store.get(name);
    for (const fact of nugget.facts) {
      if ((fact.hits || 0) < 1) continue;
      facts.push({
        nugget: name,
        key: fact.key,
        value: fact.value,
        hits: fact.hits || 0,
        updated_at: fact.updated_at || fact.created_at || "",
      });
    }
  }

  const lines = facts
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return String(b.updated_at).localeCompare(String(a.updated_at));
    })
    .slice(0, 6)
    .map((fact) => `[${fact.nugget}] ${fact.key}: ${fact.value}`);

  return lines.length ? lines.join("\n") : null;
}

export function rememberFact(nuggetOrPayload, keyArg, valueArg) {
  const payload = typeof nuggetOrPayload === "object" && nuggetOrPayload !== null
    ? {
        nugget: nuggetOrPayload.nugget ?? nuggetOrPayload.topic ?? "facts",
        key: nuggetOrPayload.key,
        value: nuggetOrPayload.value,
        data: nuggetOrPayload.data,
        tags: nuggetOrPayload.tags,
      }
    : {
        nugget: nuggetOrPayload,
        key: keyArg,
        value: valueArg,
        data: null,
        tags: null,
      };

  if (!payload.key) {
    return { saved: false, error: "key required" };
  }

  const nuggetName = payload.nugget || "facts";
  const safeKey = upsertFact(nuggetName, payload.key, payload.value, {
    data: payload.data,
    tags: payload.tags,
  });
  log("memory", `Stored fact in ${nuggetName}: ${safeKey}`);
  return { saved: true, nugget: nuggetName, key: safeKey };
}

export function recallMemory(query, nuggetName) {
  const result = recallBest(query, nuggetName || null);
  log("memory", `Recall "${query}" -> ${result.found ? result.answer : "not found"}`);
  return result;
}

export function rememberWalletScores({ pool_address, pool_name = null, scored_wallets = [], scoring = {}, metadata = {} }) {
  if (!pool_address) return { saved: false, error: "pool_address required" };
  if (!Array.isArray(scored_wallets) || scored_wallets.length === 0) {
    return { saved: false, error: "scored_wallets required" };
  }

  const topWallets = scored_wallets.slice(0, 10).map((wallet) => ({
    owner: wallet.owner,
    short_owner: wallet.short_owner,
    total_score: round(wallet.score_breakdown?.total_score, 2),
    base_score: round(wallet.score_breakdown?.base_score, 2),
    dune_bonus_points: round(wallet.score_breakdown?.dune_bonus_points || 0, 2),
    metrics: wallet.metrics || {},
    score_breakdown: wallet.score_breakdown || {},
    dune_enrichment: wallet.dune_enrichment || { status: "not_attempted" },
    sampled_positions: wallet.sampled_positions || [],
  }));

  const summary = `Wallet scores for ${pool_name || pool_address.slice(0, 8)}: ${topWallets
    .slice(0, 3)
    .map((wallet) => `${wallet.short_owner || wallet.owner?.slice(0, 8)} ${wallet.total_score}`)
    .join(", ")}`;

  const safeKey = upsertFact("wallet_scores", `wallet-score-${pool_address}`, summary, {
    tags: ["wallet_scoring", "lpagent", scoring?.dune?.enabled ? "dune_enriched" : "lpagent_only"],
    data: {
      pool_address,
      pool_name,
      scored_at: new Date().toISOString(),
      scored_wallet_count: topWallets.length,
      scoring,
      metadata,
      scored_wallets: topWallets,
    },
  });

  log("memory", `Stored wallet scores for ${pool_address.slice(0, 8)} in ${safeKey}`);
  return { saved: true, nugget: "wallet_scores", key: safeKey, scored_wallet_count: topWallets.length };
}

export function getWalletScoreMemory(poolAddress) {
  if (!poolAddress) return { found: false, error: "poolAddress required" };

  const { nugget, fact } = getFactByKey("wallet_scores", `wallet-score-${poolAddress}`);
  if (!fact) {
    return { found: false, pool_address: poolAddress };
  }

  fact.hits = (fact.hits || 0) + 1;
  fact.updated_at = new Date().toISOString();
  saveNugget(nugget);

  return {
    found: true,
    pool_address: poolAddress,
    scored_at: fact.data?.scored_at || fact.updated_at,
    age_minutes: fact.data?.scored_at
      ? Math.max(0, Math.round((Date.now() - new Date(fact.data.scored_at).getTime()) / 60000))
      : null,
    scoring: fact.data?.scoring || {},
    metadata: fact.data?.metadata || {},
    scored_wallets: fact.data?.scored_wallets || [],
  };
}

export function rememberTokenTypeDistribution({
  distribution_key,
  strategy = null,
  pool_address = null,
  pool_name = null,
  pnl_pct = null,
  fee_yield_pct = null,
  minutes_held = null,
  success = null,
}) {
  if (!distribution_key) return { saved: false, error: "distribution_key required" };

  const { nugget, fact } = getFactByKey("distribution_stats", `distribution-${distribution_key}`);
  const existing = fact?.data && typeof fact.data === "object"
    ? fact.data
    : {
        distribution_key,
        total_closed: 0,
        wins: 0,
        losses: 0,
        avg_pnl_pct: 0,
        avg_fee_yield_pct: 0,
        avg_minutes_held: 0,
        last_recorded_at: null,
        by_strategy: {},
        recent_pools: [],
      };

  const next = {
    ...existing,
    total_closed: (existing.total_closed || 0) + 1,
    wins: (existing.wins || 0) + (success ? 1 : 0),
    losses: (existing.losses || 0) + (success === false ? 1 : 0),
    last_recorded_at: new Date().toISOString(),
  };

  const total = next.total_closed;
  const currentAvgPnl = Number(existing.avg_pnl_pct || 0);
  const currentAvgFeeYield = Number(existing.avg_fee_yield_pct || 0);
  const currentAvgMinutesHeld = Number(existing.avg_minutes_held || 0);

  if (typeof pnl_pct === "number" && Number.isFinite(pnl_pct)) {
    next.avg_pnl_pct = round(((currentAvgPnl * (total - 1)) + pnl_pct) / total, 2);
  }
  if (typeof fee_yield_pct === "number" && Number.isFinite(fee_yield_pct)) {
    next.avg_fee_yield_pct = round(((currentAvgFeeYield * (total - 1)) + fee_yield_pct) / total, 2);
  }
  if (typeof minutes_held === "number" && Number.isFinite(minutes_held)) {
    next.avg_minutes_held = round(((currentAvgMinutesHeld * (total - 1)) + minutes_held) / total, 2);
  }

  const strategyKey = strategy || "unknown";
  const existingStrategy = next.by_strategy[strategyKey] || {
    total_closed: 0,
    wins: 0,
    losses: 0,
    avg_pnl_pct: 0,
  };
  const strategyTotal = existingStrategy.total_closed + 1;
  next.by_strategy = {
    ...next.by_strategy,
    [strategyKey]: {
      total_closed: strategyTotal,
      wins: existingStrategy.wins + (success ? 1 : 0),
      losses: existingStrategy.losses + (success === false ? 1 : 0),
      avg_pnl_pct: typeof pnl_pct === "number" && Number.isFinite(pnl_pct)
        ? round(((existingStrategy.avg_pnl_pct || 0) * existingStrategy.total_closed + pnl_pct) / strategyTotal, 2)
        : existingStrategy.avg_pnl_pct,
    },
  };

  if (pool_address || pool_name) {
    const recentPools = Array.isArray(next.recent_pools) ? next.recent_pools : [];
    recentPools.push({
      pool_address,
      pool_name,
      pnl_pct: round(pnl_pct, 2),
      success: success === true,
      recorded_at: next.last_recorded_at,
    });
    next.recent_pools = recentPools.slice(-8);
  }

  next.win_rate_pct = total > 0 ? round((next.wins / total) * 100, 2) : null;

  const summary = `${distribution_key}: ${next.win_rate_pct}% win rate across ${next.total_closed} closed positions, avg PnL ${next.avg_pnl_pct}%`;

  if (fact) {
    fact.value = summary;
    fact.tags = ["distribution_success", strategyKey];
    fact.data = next;
    fact.updated_at = next.last_recorded_at;
  } else {
    nugget.facts.push({
      key: sanitizeKey(`distribution-${distribution_key}`),
      value: summary,
      hits: 0,
      created_at: next.last_recorded_at,
      updated_at: next.last_recorded_at,
      tags: ["distribution_success", strategyKey],
      data: next,
    });
  }

  saveNugget(nugget);
  log("memory", `Stored distribution stats for ${distribution_key}: ${next.win_rate_pct}% win rate`);
  return { saved: true, nugget: "distribution_stats", distribution_key, total_closed: next.total_closed };
}

export function getTokenTypeDistributionMemory(distributionKey = null) {
  const nugget = getShelf().getOrCreate("distribution_stats");
  const facts = distributionKey
    ? nugget.facts.filter((fact) => fact.data?.distribution_key === distributionKey)
    : nugget.facts;

  return {
    total: facts.length,
    distributions: facts.map((fact) => ({
      distribution_key: fact.data?.distribution_key || fact.key,
      summary: fact.value,
      stats: fact.data || null,
    })),
  };
}
