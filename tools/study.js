/**
 * LP Agent research helpers for top-LPer analysis and scoring.
 * Used by study/research flows — not on every management cycle.
 */

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const DUNE_API = "https://api.dune.com/api/v1";
const DEFAULT_SCORE_LIMIT = 4;
const MAX_SCORE_LIMIT = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const _lpagentCalls = [];

function getLpAgentKey() {
  return process.env.LPAGENT_API_KEY;
}

function getDuneConfig() {
  return {
    apiKey: process.env.DUNE_API_KEY || null,
    queryId: process.env.DUNE_TOP_LPERS_QUERY_ID || process.env.DUNE_WALLET_SCORE_QUERY_ID || null,
  };
}

function checkRateLimit() {
  const now = Date.now();
  while (_lpagentCalls.length > 0 && now - _lpagentCalls[0] > 60_000) {
    _lpagentCalls.shift();
  }
  if (_lpagentCalls.length >= 5) {
    const waitSec = Math.ceil((60_000 - (now - _lpagentCalls[0])) / 1000);
    return { allowed: false, waitSec };
  }
  _lpagentCalls.push(now);
  return { allowed: true };
}

async function fetchLpAgentJson(url) {
  const lpAgentKey = getLpAgentKey();
  if (!lpAgentKey) {
    return { disabled: true, error: "LPAGENT_API_KEY not set" };
  }

  const res = await fetch(url, {
    headers: { "x-api-key": lpAgentKey },
  });

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before calling LP Agent again.");
    }
    throw new Error(`LP Agent API error: ${res.status}`);
  }

  return res.json();
}

async function fetchTopLPersRaw(poolAddress) {
  return fetchLpAgentJson(`${LPAGENT_API}/pools/${poolAddress}/top-lpers?sort_order=desc&page=1&limit=20`);
}

async function fetchHistoricalPositions(owner) {
  const data = await fetchLpAgentJson(
    `${LPAGENT_API}/lp-positions/historical?owner=${owner}&page=1&limit=50`
  );
  return data?.data || [];
}

function filterCredibleLPers(all) {
  return all.filter((lper) => lper.total_lp >= 3 && lper.win_rate >= 0.6 && lper.total_inflow > 1000);
}

function getScoreCandidates(all) {
  const credible = all.filter((lper) => lper.total_lp >= 3 && lper.total_inflow > 1000);
  if (credible.length > 0) return { candidates: credible, source: "credible_filter" };

  return {
    candidates: all.filter((lper) => (lper.total_lp || 0) >= 1 && (lper.total_inflow || 0) > 0),
    source: "fallback_any_activity",
  };
}

function rankSeedCandidate(a, b) {
  const scoreA = ((a.win_rate || 0) * 0.45) + ((a.roi || 0) * 0.35) + ((a.fee_percent || 0) * 0.2);
  const scoreB = ((b.win_rate || 0) * 0.45) + ((b.roi || 0) * 0.35) + ((b.fee_percent || 0) * 0.2);
  return scoreB - scoreA;
}

function buildHistoricalSample(lper, positions) {
  return {
    owner: shortOwner(lper.owner),
    summary: {
      total_positions: lper.total_lp,
      win_rate: `${Math.round((lper.win_rate || 0) * 100)}%`,
      avg_hold_hours: numberOrNull(lper.avg_age_hour, 2),
      roi: `${((lper.roi || 0) * 100).toFixed(2)}%`,
      fee_pct_of_capital: `${((lper.fee_percent || 0) * 100).toFixed(2)}%`,
      total_pnl_usd: Math.round(lper.total_pnl || 0),
    },
    positions: positions.map((position) => ({
      pool: position.pool,
      pair: position.pairName || `${position.tokenName0}-${position.tokenName1}`,
      hold_hours: position.ageHour != null ? numberOrNull(position.ageHour, 2) : null,
      pnl_usd: Math.round(position.pnl?.value || 0),
      pnl_pct: `${((position.pnl?.percent || 0) * 100).toFixed(1)}%`,
      fee_usd: Math.round(position.collectedFee || 0),
      in_range_pct: position.inRangePct != null ? `${Math.round(position.inRangePct * 100)}%` : null,
      strategy: position.strategy || null,
      closed_reason: position.closeReason || null,
    })),
  };
}

function summarizePatterns(top) {
  return {
    top_lper_count: top.length,
    avg_hold_hours: avg(top.map((lper) => lper.avg_age_hour).filter(isNum)),
    avg_win_rate: avg(top.map((lper) => lper.win_rate).filter(isNum)),
    avg_roi_pct: avg(top.map((lper) => lper.roi * 100).filter(isNum)),
    avg_fee_pct_of_capital: avg(top.map((lper) => lper.fee_percent * 100).filter(isNum)),
    best_roi: (Math.max(...top.map((lper) => lper.roi)) * 100).toFixed(2) + "%",
    scalper_count: top.filter((lper) => lper.avg_age_hour < 1).length,
    holder_count: top.filter((lper) => lper.avg_age_hour >= 4).length,
  };
}

export async function studyTopLPers({ pool_address, limit = 4 }) {
  if (!getLpAgentKey()) {
    return { pool: pool_address, message: "LPAGENT_API_KEY not set in .env — study_top_lpers is disabled.", patterns: [], lpers: [] };
  }

  const topData = await fetchTopLPersRaw(pool_address);
  const all = topData.data || [];
  const credible = filterCredibleLPers(all);
  const top = credible.sort((a, b) => b.roi - a.roi).slice(0, limit);

  if (top.length === 0) {
    return {
      pool: pool_address,
      message: "No credible LPers found (need >=3 positions, >=60% win rate, >=$1k inflow).",
      patterns: [],
      historical_samples: [],
    };
  }

  const historicalSamples = [];
  for (const lper of top) {
    try {
      await sleep(1000);
      const positions = await fetchHistoricalPositions(lper.owner);
      historicalSamples.push(buildHistoricalSample(lper, positions));
    } catch {
      // best-effort only
    }
  }

  return {
    pool: pool_address,
    patterns: summarizePatterns(top),
    lpers: historicalSamples,
  };
}

export async function scoreTopLPers({ pool_address, limit = DEFAULT_SCORE_LIMIT } = {}) {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit || DEFAULT_SCORE_LIMIT)), MAX_SCORE_LIMIT);

  if (!getLpAgentKey()) {
    return {
      pool: pool_address,
      message: "LPAGENT_API_KEY not set in .env — score_top_lpers is disabled.",
      candidates: [],
      source_status: {
        lpagent: { enabled: false, status: "missing_api_key" },
        dune: { enabled: false, status: "skipped_missing_credentials" },
      },
    };
  }

  const topData = await fetchTopLPersRaw(pool_address);
  const all = topData.data || [];
  const { candidates, source } = getScoreCandidates(all);

  if (candidates.length === 0) {
    return {
      pool: pool_address,
      message: "No LP wallets with enough LP Agent activity were found for scoring.",
      candidates: [],
      source_status: {
        lpagent: { enabled: true, status: "ok", returned: all.length },
        dune: { enabled: false, status: "not_attempted" },
      },
    };
  }

  const seeded = [...candidates].sort(rankSeedCandidate).slice(0, safeLimit);
  const dune = await fetchDuneWalletEnrichment(pool_address, seeded.map((candidate) => candidate.owner));
  const scored = [];

  for (let index = 0; index < seeded.length; index += 1) {
    const candidate = seeded[index];
    let positions = [];

    try {
      if (index > 0) await sleep(1000);
      positions = await fetchHistoricalPositions(candidate.owner);
    } catch {
      positions = [];
    }

    scored.push(buildWalletScore(candidate, positions, dune.wallets[candidate.owner] || null));
  }

  scored.sort((a, b) => (b.score_breakdown?.total_score || 0) - (a.score_breakdown?.total_score || 0));

  const result = {
    pool: pool_address,
    candidate_count: scored.length,
    scoring_model: {
      version: "meridian-lper-v1",
      lpagent_weights: {
        sample_size: 14,
        win_rate: 24,
        fee_yield: 18,
        capital_efficiency: 18,
        diversification: 12,
        recency: 14,
      },
      dune_bonus_cap_points: 8,
    },
    filters_applied: {
      source,
      safe_limit,
      credible_filter: "total_lp >= 3, total_inflow > 1000; study flow also keeps win_rate >= 0.60",
    },
    source_status: {
      lpagent: {
        enabled: true,
        status: "ok",
        returned: all.length,
        candidate_source: source,
      },
      dune: dune.meta,
    },
    candidates: scored,
  };

	return result;
}

function buildWalletScore(lper, positions, duneRow) {
  const uniquePools = new Set(positions.map((position) => position.pool).filter(Boolean));
  const uniqueStrategies = new Set(positions.map((position) => position.strategy).filter(Boolean));
  const recentActivityShare = positions.length > 0
    ? positions.filter((position) => isNum(position.ageHour) && position.ageHour <= 24).length / positions.length
    : recencyFromAverageAge(lper.avg_age_hour);
  const diversificationRaw = positions.length > 0
    ? clamp01(((uniquePools.size / Math.min(positions.length, 8)) * 0.75) + ((uniqueStrategies.size / Math.max(1, Math.min(positions.length, 4))) * 0.25))
    : clamp01((lper.total_lp || 0) / 10);
  const capitalEfficiencyRaw = Math.max(
    0,
    (safeDivide(lper.total_pnl, lper.total_inflow) * 0.6) + (Math.max(lper.roi || 0, 0) * 0.4)
  );

  const components = {
    sample_size: buildComponent(lper.total_lp, normalizeScore(lper.total_lp, 3, 12), 14, "LP sample depth from total closed positions"),
    win_rate: buildComponent((lper.win_rate || 0) * 100, clamp01(lper.win_rate || 0), 24, "Historical wallet win rate"),
    fee_yield: buildComponent((lper.fee_percent || 0) * 100, normalizeScore(lper.fee_percent, 0.01, 0.12), 18, "Fees earned as a share of deployed capital"),
    capital_efficiency: buildComponent(capitalEfficiencyRaw * 100, normalizeScore(capitalEfficiencyRaw, 0.02, 0.3), 18, "Profit extracted per dollar deployed"),
    diversification: buildComponent(diversificationRaw * 100, diversificationRaw, 12, "Breadth across pools and strategies"),
    recency: buildComponent(recentActivityShare * 100, clamp01(recentActivityShare), 14, "Share of sampled positions active within the last 24h proxy"),
  };

  const baseScore = round(Object.values(components).reduce((sum, component) => sum + component.contribution_points, 0), 2);
  const duneBonus = buildDuneBonus(duneRow);

  return {
    owner: lper.owner,
    short_owner: shortOwner(lper.owner),
    eligibility: {
      meets_study_filter: lper.total_lp >= 3 && lper.win_rate >= 0.6 && lper.total_inflow > 1000,
      candidate_seed_source: lper.total_lp >= 3 && lper.total_inflow > 1000 ? "credible_filter" : "fallback_any_activity",
    },
    metrics: {
      total_lp: lper.total_lp || 0,
      win_rate_pct: round((lper.win_rate || 0) * 100, 2),
      roi_pct: round((lper.roi || 0) * 100, 2),
      fee_yield_pct_of_capital: round((lper.fee_percent || 0) * 100, 2),
      total_inflow_usd: round(lper.total_inflow || 0, 2),
      total_pnl_usd: round(lper.total_pnl || 0, 2),
      avg_hold_hours: numberOrNull(lper.avg_age_hour, 2),
      capital_efficiency_pct: round(capitalEfficiencyRaw * 100, 2),
      diversification_pct: round(diversificationRaw * 100, 2),
      recent_activity_share_pct: round(recentActivityShare * 100, 2),
      unique_pools: uniquePools.size,
      sampled_history_count: positions.length,
    },
    score_breakdown: {
      base_score: baseScore,
      dune_bonus_points: duneBonus.points,
      total_score: round(Math.min(100, baseScore + duneBonus.points), 2),
      components,
    },
    dune_enrichment: duneBonus.payload,
    sampled_positions: positions.slice(0, 5).map((position) => ({
      pool: position.pool,
      pair: position.pairName || `${position.tokenName0}-${position.tokenName1}`,
      strategy: position.strategy || null,
      hold_hours: numberOrNull(position.ageHour, 2),
      pnl_pct: round((position.pnl?.percent || 0) * 100, 2),
      fee_usd: round(position.collectedFee || 0, 2),
      close_reason: position.closeReason || null,
    })),
  };
}

async function fetchDuneWalletEnrichment(poolAddress, owners) {
  const config = getDuneConfig();

  if (!config.apiKey || !config.queryId) {
    return {
      meta: { enabled: false, status: "skipped_missing_credentials", query_id: config.queryId || null },
      wallets: {},
    };
  }

  try {
    const params = new URLSearchParams({ limit: "200" });
    if (poolAddress) params.set("pool_address", poolAddress);

    const res = await fetch(`${DUNE_API}/query/${config.queryId}/results?${params.toString()}`, {
      headers: {
        "X-Dune-API-Key": config.apiKey,
      },
    });

    if (!res.ok) {
      return {
        meta: {
          enabled: true,
          status: res.status === 401 || res.status === 403 || res.status === 402 ? "unavailable_credentials_or_plan" : `unavailable_${res.status}`,
          query_id: config.queryId,
        },
        wallets: {},
      };
    }

    const payload = await res.json();
    const rows = extractDuneRows(payload);
    const ownerSet = new Set(owners);
    const wallets = {};

    for (const row of rows) {
      const wallet = extractWalletAddress(row);
      if (!wallet || !ownerSet.has(wallet)) continue;

      wallets[wallet] = {
        wallet,
        trailing_30d_pnl_usd: toFiniteNumber(row.trailing_30d_pnl_usd ?? row.pnl_usd ?? row.realized_pnl_usd, null),
        win_rate_30d: normalizeWinRate(row.win_rate_30d ?? row.win_rate ?? row.win_rate_pct),
        distinct_pools: toFiniteNumber(row.distinct_pools ?? row.pools_traded ?? row.pool_count, null),
      };
    }

    return {
      meta: {
        enabled: true,
        status: Object.keys(wallets).length > 0 ? "ok" : "no_matching_rows",
        query_id: config.queryId,
        matched_wallets: Object.keys(wallets).length,
      },
      wallets,
    };
  } catch {
    return {
      meta: { enabled: true, status: "error", query_id: config.queryId },
      wallets: {},
    };
  }
}

function extractDuneRows(payload) {
  if (Array.isArray(payload?.result?.rows)) return payload.result.rows;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.result?.data?.rows)) return payload.result.data.rows;
  return [];
}

function extractWalletAddress(row) {
  if (!row || typeof row !== "object") return null;
  return row.wallet_address || row.wallet || row.owner || row.address || null;
}

function buildDuneBonus(row) {
  if (!row) {
    return {
      points: 0,
      payload: { enabled: false, status: "not_available", bonus_points: 0 },
    };
  }

  const pnlScore = normalizeScore(row.trailing_30d_pnl_usd, 0, 5000);
  const winRateScore = row.win_rate_30d == null ? null : clamp01(row.win_rate_30d);
  const breadthScore = normalizeScore(row.distinct_pools, 2, 12);
  const signals = [pnlScore, breadthScore];
  if (isNum(winRateScore)) signals.push(winRateScore);

  const normalized = signals.length > 0 ? signals.reduce((sum, value) => sum + value, 0) / signals.length : 0;
  const points = round(normalized * 8, 2);

  return {
    points,
    payload: {
      enabled: true,
      status: "matched",
      bonus_points: points,
      metrics: {
        trailing_30d_pnl_usd: row.trailing_30d_pnl_usd,
        win_rate_30d: row.win_rate_30d != null ? round(row.win_rate_30d * 100, 2) : null,
        distinct_pools: row.distinct_pools,
      },
    },
  };
}

export async function getPoolInfo({ pool_address }) {
  if (!getLpAgentKey()) {
    return { error: "LPAGENT_API_KEY not set — get_pool_info is disabled." };
  }

  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    return { error: `Rate limited (5/min). Try again in ${rateCheck.waitSec}s.` };
  }

  const raw = await fetchLpAgentJson(`${LPAGENT_API}/pools/${pool_address}/info`);
  const d = raw.data;
  if (!d) return { error: "No data returned for this pool." };

  const tokens = d.tokenInfo?.[0]?.data || [];
  const tokenX = tokens[0] || {};
  const tokenY = tokens[1] || {};
  const feeInfo = d.feeInfo || {};

  const result = {
    pool: pool_address,
    type: d.type,
    token_x: {
      symbol: tokenX.symbol,
      name: tokenX.name,
      mcap: tokenX.mcap,
      fdv: tokenX.fdv,
      price_usd: tokenX.usdPrice,
      organic_score: tokenX.organicScore,
      holders: tokenX.holderCount,
      mint_disabled: tokenX.audit?.mintAuthorityDisabled,
      freeze_disabled: tokenX.audit?.freezeAuthorityDisabled,
      top_holders_pct: tokenX.audit?.topHoldersPercentage,
      bot_holders_pct: tokenX.audit?.botHoldersPercentage,
      dev_balance_pct: tokenX.audit?.devBalancePercentage,
      dev_migrations: tokenX.audit?.devMigrations,
      cto: tokenX.cto,
      tags: tokenX.tags,
    },
    token_y: {
      symbol: tokenY.symbol,
      name: tokenY.name,
    },
    amount_x: d.amountX,
    amount_y: d.amountY,
    fees: {
      base_fee_pct: feeInfo.baseFeeRatePercentage,
      max_fee_pct: feeInfo.maxFeeRatePercentage,
      dynamic_fee: feeInfo.dynamicFee,
    },
    stats_5m: tokenX.stats5m ? {
      price_change: tokenX.stats5m.priceChange,
      buy_volume: tokenX.stats5m.buyVolume,
      sell_volume: tokenX.stats5m.sellVolume,
      num_buys: tokenX.stats5m.numBuys,
      num_sells: tokenX.stats5m.numSells,
      num_traders: tokenX.stats5m.numTraders,
      organic_buy_ratio: tokenX.stats5m.numOrganicBuyers / (tokenX.stats5m.numTraders || 1),
    } : null,
    stats_1h: tokenX.stats1h ? {
      price_change: tokenX.stats1h.priceChange,
      buy_volume: tokenX.stats1h.buyVolume,
      sell_volume: tokenX.stats1h.sellVolume,
      num_traders: tokenX.stats1h.numTraders,
    } : null,
    fee_trend_7d: (d.feeStats || []).slice(-24).map((hour) => ({
      hour: hour.hour,
      fee_usd: hour.feeUsd,
    })),
  };

	return result;
}

function buildComponent(rawValue, normalizedScore, weightPoints, explanation) {
  return {
    raw_value: round(rawValue, 2),
    normalized_score: round(normalizedScore, 4),
    weight_points: weightPoints,
    contribution_points: round(clamp01(normalizedScore) * weightPoints, 2),
    explanation,
  };
}

function normalizeScore(value, min, max) {
  if (!isNum(value)) return 0;
  if (value <= min) return 0;
  if (value >= max) return 1;
  return clamp01((value - min) / (max - min));
}

function normalizeWinRate(value) {
  if (!isNum(value)) return null;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

function recencyFromAverageAge(avgAgeHours) {
  if (!isNum(avgAgeHours)) return 0.5;
  return clamp01(1 / (1 + Math.max(avgAgeHours, 0) / 24));
}

function safeDivide(numerator, denominator) {
  return isNum(numerator) && isNum(denominator) && denominator > 0 ? numerator / denominator : 0;
}

function shortOwner(owner) {
  return owner ? `${owner.slice(0, 8)}...` : null;
}

function numberOrNull(value, decimals = 2) {
  return isNum(value) ? round(value, decimals) : null;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((sum, value) => sum + value, 0) / arr.length) * 100) / 100;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value || 0));
}

function round(value, decimals = 2) {
  if (!isNum(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}
