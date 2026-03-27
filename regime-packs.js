import fs from "fs";
import path from "path";

const REGIME_PACKS = {
  defensive: {
    regime: "defensive",
    screening_overrides: {
      minFeeActiveTvlRatio: 0.1,
      minOrganic: 72,
      minVolume: 1200,
      minHolders: 900,
    },
    deploy: {
      regime_multiplier: 0.75,
    },
  },
  neutral: {
    regime: "neutral",
    screening_overrides: {},
    deploy: {
      regime_multiplier: 1,
    },
  },
  offensive: {
    regime: "offensive",
    screening_overrides: {
      minFeeActiveTvlRatio: 0.04,
      minOrganic: 58,
      minVolume: 350,
      minHolders: 400,
    },
    deploy: {
      regime_multiplier: 1.2,
    },
  },
};

const REGIME_NAMES = Object.keys(REGIME_PACKS);
const HIGH_UTILIZATION_THRESHOLD = 2 / 3;
const REGIME_STATE_FILE = process.env.ZENITH_REGIME_STATE_FILE || path.join("./data", "regime-state.json");
const ACTIVE_DWELL_MS = 45 * 60 * 1000;
const PENDING_DECAY_MS = 3 * 60 * 60 * 1000;

function loadRegimeState() {
  if (!fs.existsSync(REGIME_STATE_FILE)) {
    return {
      active_regime: null,
      activated_at: null,
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(REGIME_STATE_FILE, "utf8"));
    return {
      active_regime: parsed?.active_regime || null,
      activated_at: parsed?.activated_at || null,
      pending_regime: parsed?.pending_regime || null,
      pending_hits: Number(parsed?.pending_hits) || 0,
      pending_since: parsed?.pending_since || null,
      last_reason: parsed?.last_reason || null,
    };
  } catch {
    return {
      active_regime: null,
      activated_at: null,
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: null,
    };
  }
}

function saveRegimeState(state) {
  fs.mkdirSync(path.dirname(REGIME_STATE_FILE), { recursive: true });
  fs.writeFileSync(REGIME_STATE_FILE, JSON.stringify(state, null, 2));
}

function isImmediateProtectiveClassification(classification = {}) {
  if (classification?.regime !== "defensive") return false;
  return classification.confidence === "high" || [
    "low_wallet_buffer",
    "high_position_utilization",
    "weak_recent_realized_performance",
  ].includes(classification.reason);
}

export function getRegimePack(regime) {
  return REGIME_PACKS[regime] || REGIME_PACKS.neutral;
}

export function classifyRuntimeRegime({
  walletSol,
  positionsCount = 0,
  maxPositions = 1,
  deployFloor = 0,
  gasReserve = 0,
  performanceSummary = null,
  marketPools = [],
  forcedRegime = null,
} = {}) {
  if (forcedRegime && REGIME_PACKS[forcedRegime]) {
    return {
      regime: forcedRegime,
      reason: "forced_override",
      confidence: "high",
    };
  }

  const normalizedWallet = Number(walletSol);
  const normalizedPositionsCount = Number(positionsCount) || 0;
  const normalizedMaxPositions = Math.max(1, Number(maxPositions) || 1);
  const utilization = normalizedPositionsCount / normalizedMaxPositions;
  const requiredToDeploy = Number(deployFloor) + Number(gasReserve);

  if (Number.isFinite(normalizedWallet) && Number.isFinite(requiredToDeploy)) {
    if (normalizedWallet < requiredToDeploy * 1.35) {
      return {
        regime: "defensive",
        reason: "low_wallet_buffer",
        confidence: "high",
      };
    }
  }

  if (utilization >= HIGH_UTILIZATION_THRESHOLD) {
    return {
      regime: "defensive",
      reason: "high_position_utilization",
      confidence: "medium",
    };
  }

  const sampleSize = Number(performanceSummary?.total_positions_closed) || 0;
  const winRate = Number(performanceSummary?.win_rate_pct);
  const avgPnlPct = Number(performanceSummary?.avg_pnl_pct);

  if (sampleSize >= 5 && Number.isFinite(winRate) && Number.isFinite(avgPnlPct)) {
    if (winRate <= 40 || avgPnlPct <= -1) {
      return {
        regime: "defensive",
        reason: "weak_recent_realized_performance",
        confidence: "high",
      };
    }
    if (winRate >= 65 && avgPnlPct >= 1.5) {
      return {
        regime: "offensive",
        reason: "strong_recent_realized_performance",
        confidence: "medium",
      };
    }
  }

  const poolSample = Array.isArray(marketPools) ? marketPools.slice(0, 10) : [];
  if (poolSample.length > 0) {
    const avgVolatility = poolSample
      .map((pool) => Number(pool.volatility))
      .filter(Number.isFinite)
      .reduce((sum, value, _, values) => sum + value / values.length, 0);
    const avgOrganic = poolSample
      .map((pool) => Number(pool.organic_score))
      .filter(Number.isFinite)
      .reduce((sum, value, _, values) => sum + value / values.length, 0);
    const hotShare = poolSample.filter((pool) => Number(pool.volatility) >= 9 || Number(pool.price_change_pct) >= 40).length / poolSample.length;

    if ((Number.isFinite(avgVolatility) && avgVolatility >= 8) || hotShare >= 0.4) {
      return {
        regime: "defensive",
        reason: "hot_market_snapshot",
        confidence: "medium",
      };
    }

    if (Number.isFinite(avgVolatility) && avgVolatility <= 4 && Number.isFinite(avgOrganic) && avgOrganic >= 78 && hotShare <= 0.15) {
      return {
        regime: "offensive",
        reason: "calm_high_quality_market_snapshot",
        confidence: "medium",
      };
    }
  }

  return {
    regime: "neutral",
    reason: "default_baseline",
    confidence: "low",
  };
}

export function resolveRegimePackContext({
  baseScreeningConfig,
  classification,
} = {}) {
  const regime = classification?.regime && REGIME_PACKS[classification.regime]
    ? classification.regime
    : "neutral";
  const pack = getRegimePack(regime);
  const effectiveScreeningConfig = {
    ...(baseScreeningConfig || {}),
    ...pack.screening_overrides,
  };

  return {
    regime,
    pack,
    effectiveScreeningConfig,
    reason: classification?.reason || "default_baseline",
    confidence: classification?.confidence || "low",
  };
}

export function applyRegimeHysteresis({
  classification,
  nowMs = Date.now(),
} = {}) {
  const state = loadRegimeState();
  const proposedRegime = classification?.regime || "neutral";
  const activeRegime = state.active_regime || null;
  const activeAgeMs = Number.isFinite(Date.parse(state.activated_at || ""))
    ? Math.max(0, nowMs - Date.parse(state.activated_at))
    : Number.POSITIVE_INFINITY;

  if (!activeRegime) {
    const next = {
      active_regime: proposedRegime,
      activated_at: new Date(nowMs).toISOString(),
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: classification?.reason || null,
    };
    saveRegimeState(next);
    return {
      ...classification,
      regime: proposedRegime,
      switched: true,
      hysteresis_reason: "initial_activation",
      proposed_regime: proposedRegime,
      pending_regime: null,
      pending_hits: 0,
    };
  }

  if (proposedRegime === activeRegime) {
    const next = {
      ...state,
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: classification?.reason || state.last_reason || null,
    };
    saveRegimeState(next);
    return {
      ...classification,
      regime: activeRegime,
      switched: false,
      hysteresis_reason: "stable_active_regime",
      proposed_regime: proposedRegime,
      pending_regime: null,
      pending_hits: 0,
    };
  }

  if (isImmediateProtectiveClassification(classification)) {
    const next = {
      active_regime: proposedRegime,
      activated_at: new Date(nowMs).toISOString(),
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: classification?.reason || null,
    };
    saveRegimeState(next);
    return {
      ...classification,
      regime: proposedRegime,
      switched: true,
      hysteresis_reason: "protective_immediate_switch",
      proposed_regime: proposedRegime,
      pending_regime: null,
      pending_hits: 0,
    };
  }

  const pendingSinceMs = Number.isFinite(Date.parse(state.pending_since || ""))
    ? Date.parse(state.pending_since)
    : null;
  const pendingExpired = pendingSinceMs != null && (nowMs - pendingSinceMs) > PENDING_DECAY_MS;
  const priorPendingHits = pendingExpired ? 0 : (state.pending_hits || 0);
  const pendingRegime = proposedRegime;
  const pendingHits = state.pending_regime === proposedRegime && !pendingExpired ? priorPendingHits + 1 : 1;

  if (activeAgeMs < ACTIVE_DWELL_MS) {
    const next = {
      ...state,
      pending_regime: pendingRegime,
      pending_hits: pendingHits,
      pending_since: state.pending_regime === proposedRegime && !pendingExpired
        ? state.pending_since || new Date(nowMs).toISOString()
        : new Date(nowMs).toISOString(),
      last_reason: classification?.reason || state.last_reason || null,
    };
    saveRegimeState(next);
    return {
      ...classification,
      regime: activeRegime,
      switched: false,
      hysteresis_reason: "active_dwell_window",
      proposed_regime: proposedRegime,
      pending_regime: pendingRegime,
      pending_hits: pendingHits,
      active_dwell_remaining_ms: ACTIVE_DWELL_MS - activeAgeMs,
    };
  }

  if (pendingHits >= 2) {
    const next = {
      active_regime: proposedRegime,
      activated_at: new Date(nowMs).toISOString(),
      pending_regime: null,
      pending_hits: 0,
      pending_since: null,
      last_reason: classification?.reason || null,
    };
    saveRegimeState(next);
    return {
      ...classification,
      regime: proposedRegime,
      switched: true,
      hysteresis_reason: "confirmed_switch",
      proposed_regime: proposedRegime,
      pending_regime: null,
      pending_hits: 0,
    };
  }

  const next = {
    ...state,
    pending_regime: pendingRegime,
    pending_hits: pendingHits,
    pending_since: state.pending_regime === proposedRegime ? state.pending_since || new Date(nowMs).toISOString() : new Date(nowMs).toISOString(),
    last_reason: classification?.reason || state.last_reason || null,
  };
  saveRegimeState(next);
  return {
    ...classification,
    regime: activeRegime,
    switched: false,
    hysteresis_reason: pendingExpired ? "pending_signal_decayed" : "awaiting_confirmation",
    proposed_regime: proposedRegime,
    pending_regime: pendingRegime,
    pending_hits: pendingHits,
  };
}

export function listCounterfactualRegimes(activeRegime) {
  return REGIME_NAMES.filter((regime) => regime !== activeRegime);
}

export function getPerformanceSizingMultiplier(performanceSummary = null) {
  const sampleSize = Number(performanceSummary?.total_positions_closed) || 0;
  if (sampleSize < 5) return 1;

  const winRate = Number(performanceSummary?.win_rate_pct);
  const avgPnlPct = Number(performanceSummary?.avg_pnl_pct);
  if (!Number.isFinite(winRate) || !Number.isFinite(avgPnlPct)) return 1;

  if (winRate <= 40 || avgPnlPct <= -1) return 0.8;
  if (winRate >= 65 && avgPnlPct >= 1.5) return 1.1;
  return 1;
}

export function getRiskSizingMultiplier({ positionsCount = 0, maxPositions = 1 } = {}) {
  const normalizedCount = Number(positionsCount) || 0;
  const normalizedMax = Math.max(1, Number(maxPositions) || 1);
  const utilization = normalizedCount / normalizedMax;

  if (utilization >= HIGH_UTILIZATION_THRESHOLD) return 0.85;
  if (utilization <= 0.33) return 1.05;
  return 1;
}

export function inferPerformanceRegimeSignal(perf = {}) {
  const volatility = Number(perf.volatility);
  const organic = Number(perf.organic_score);
  const feeRatio = Number(perf.fee_tvl_ratio);

  if (Number.isFinite(volatility) && volatility >= 12) return "defensive";
  if (Number.isFinite(organic) && Number.isFinite(feeRatio) && organic >= 78 && feeRatio >= 0.2) return "offensive";
  return "neutral";
}
