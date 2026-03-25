/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_RECENT_CYCLES = 25;
const MAX_RECENT_TOOL_OUTCOMES = 40;

function emptyState() {
  return {
    positions: {},
    recentEvents: [],
    evaluation: {
      recentCycles: [],
      recentToolOutcomes: [],
      counters: {
        management_cycles: 0,
        screening_cycles: 0,
        health_checks: 0,
        candidates_scored: 0,
        candidates_blocked: 0,
        runtime_actions_handled: 0,
        runtime_actions_attempted: 0,
        tool_blocks: 0,
        tool_errors: 0,
        write_successes: 0,
      },
    },
    lastUpdated: null,
  };
}

function ensureEvaluation(state) {
  if (!state.evaluation || typeof state.evaluation !== "object") {
    state.evaluation = emptyState().evaluation;
  }

  state.evaluation.recentCycles = Array.isArray(state.evaluation.recentCycles)
    ? state.evaluation.recentCycles
    : [];
  state.evaluation.recentToolOutcomes = Array.isArray(state.evaluation.recentToolOutcomes)
    ? state.evaluation.recentToolOutcomes
    : [];
  state.evaluation.counters = {
    ...emptyState().evaluation.counters,
    ...(state.evaluation.counters || {}),
  };

  return state.evaluation;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const state = {
      ...emptyState(),
      ...parsed,
    };
    ensureEvaluation(state);
    return state;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return emptyState();
  }
}

function save(state) {
  try {
    ensureEvaluation(state);
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

function incrementCounter(state, key, amount = 1) {
  const evaluation = ensureEvaluation(state);
  evaluation.counters[key] = (evaluation.counters[key] || 0) + amount;
}

function summarizeCycleRecord(record) {
  return {
    ts: record.ts,
    cycle_type: record.cycle_type,
    status: record.status,
    summary: record.summary,
  };
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  base_mint = null,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    base_mint,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    claim_count: 0,
    rebalance_count: 0,
    peak_pnl_pct: 0,
    trailing_active: false,
    closed: false,
    closed_at: null,
    notes: [],
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
   pos.claim_count = (pos.claim_count || 0) + 1;
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

export function recordCycleEvaluation({
  cycle_type,
  status = "completed",
  summary = {},
  candidates = [],
  positions = [],
}) {
  if (!cycle_type) return;

  const state = load();
  const evaluation = ensureEvaluation(state);
  const record = {
    ts: new Date().toISOString(),
    cycle_type,
    status,
    summary,
    candidates: Array.isArray(candidates) ? candidates.slice(0, 8) : [],
    positions: Array.isArray(positions) ? positions.slice(0, 8) : [],
  };

  evaluation.recentCycles.push(record);
  if (evaluation.recentCycles.length > MAX_RECENT_CYCLES) {
    evaluation.recentCycles = evaluation.recentCycles.slice(-MAX_RECENT_CYCLES);
  }

  if (cycle_type === "management") incrementCounter(state, "management_cycles");
  if (cycle_type === "screening") incrementCounter(state, "screening_cycles");
  if (cycle_type === "health") incrementCounter(state, "health_checks");
  if (summary.candidates_scored) incrementCounter(state, "candidates_scored", Number(summary.candidates_scored) || 0);
  if (summary.candidates_blocked) incrementCounter(state, "candidates_blocked", Number(summary.candidates_blocked) || 0);
  if (summary.runtime_actions_handled) incrementCounter(state, "runtime_actions_handled", Number(summary.runtime_actions_handled) || 0);
  if (summary.runtime_actions_attempted) incrementCounter(state, "runtime_actions_attempted", Number(summary.runtime_actions_attempted) || 0);

  save(state);
}

export function recordToolOutcome({ tool, outcome, reason = null, metadata = null }) {
  if (!tool || !outcome) return;

  const state = load();
  const evaluation = ensureEvaluation(state);
  const entry = {
    ts: new Date().toISOString(),
    tool,
    outcome,
    reason,
    metadata,
  };

  evaluation.recentToolOutcomes.push(entry);
  if (evaluation.recentToolOutcomes.length > MAX_RECENT_TOOL_OUTCOMES) {
    evaluation.recentToolOutcomes = evaluation.recentToolOutcomes.slice(-MAX_RECENT_TOOL_OUTCOMES);
  }

  if (outcome === "blocked") incrementCounter(state, "tool_blocks");
  if (outcome === "error") incrementCounter(state, "tool_errors");
  if (outcome === "success") incrementCounter(state, "write_successes");

  save(state);
}

export function getEvaluationSummary(limit = 5) {
  const state = load();
  const evaluation = ensureEvaluation(state);

  return {
    counters: evaluation.counters,
    recent_cycles: evaluation.recentCycles.slice(-limit).map(summarizeCycleRecord),
    recent_tool_outcomes: evaluation.recentToolOutcomes.slice(-limit),
  };
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = instruction || null;
  save(state);
  log("state", `Position ${position_address} instruction set: ${instruction}`);
  return true;
}

/**
 * Update peak PnL and check trailing take profit / stop loss.
 * Returns an action string if a threshold is hit, or null.
 */
export function updatePnlAndCheckExits(position_address, currentPnlPct, config) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const mgmt = config.management;
  let action = null;

  if (mgmt.stopLossPct != null && currentPnlPct <= mgmt.stopLossPct) {
    action = `STOP_LOSS: PnL ${currentPnlPct.toFixed(1)}% hit stop loss (${mgmt.stopLossPct}%)`;
    pos.notes.push(action);
    save(state);
    return action;
  }

  if (currentPnlPct > (pos.peak_pnl_pct || 0)) {
    pos.peak_pnl_pct = currentPnlPct;
  }

  if (mgmt.trailingTakeProfit) {
    if (!pos.trailing_active && currentPnlPct >= mgmt.trailingTriggerPct) {
      pos.trailing_active = true;
      pos.notes.push(`Trailing TP activated at ${currentPnlPct.toFixed(1)}%`);
      log("state", `Position ${position_address} trailing TP activated (peak: ${currentPnlPct.toFixed(1)}%)`);
    }

    if (pos.trailing_active) {
      const dropFromPeak = (pos.peak_pnl_pct || 0) - currentPnlPct;
      if (dropFromPeak >= mgmt.trailingDropPct) {
        action = `TRAILING_TP: PnL dropped ${dropFromPeak.toFixed(1)}% from peak ${(pos.peak_pnl_pct || 0).toFixed(1)}% (trail: ${mgmt.trailingDropPct}%)`;
        pos.notes.push(action);
        save(state);
        return action;
      }
    }
  }

  save(state);
  return action;
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    evaluation: getEvaluationSummary(3),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
