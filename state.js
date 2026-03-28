/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";
import { log } from "./logger.js";
import { foldActionJournal, readActionJournal } from "./action-journal.js";
import { evaluateTrackedPositionExit } from "./runtime-policy.js";
import {
	ensureEvaluationState,
	getEvaluationSummaryFromState,
	recordCycleEvaluationInState,
	recordToolOutcomeInState,
} from "./state-evaluation.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
function emptyState() {
  return {
    positions: {},
    recentEvents: [],
    evaluation: ensureEvaluationState({}).evaluation,
    lastUpdated: null,
  };
}

function load() {
	const snapshot = readJsonSnapshotWithBackupSync(STATE_FILE);
	if (!snapshot.value) {
		if (!snapshot.error) {
		return emptyState();
		}
		log("state_error", `Failed to read state.json: ${snapshot.error}`);
		throw new Error(`Invalid state.json: ${snapshot.error}`);
	}
	const state = {
		...emptyState(),
		...snapshot.value,
	};
	ensureEvaluationState(state);
	if (snapshot.source === "backup") {
		log("state_warn", "Recovered state.json from backup snapshot");
	}
	return state;
}

function save(state) {
	try {
		ensureEvaluationState(state);
		state.lastUpdated = new Date().toISOString();
		writeJsonSnapshotAtomicSync(STATE_FILE, state);
	} catch (err) {
		log("state_error", `Failed to write state.json: ${err.message}`);
		throw err;
	}
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
  opened_by_cycle_id = null,
  opened_by_action_id = null,
  opened_by_workflow_id = null,
  regime_label = null,
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
      opened_by_cycle_id,
      opened_by_action_id,
      opened_by_workflow_id,
      regime_label,
      active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    out_of_range_direction: null,
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
export function markOutOfRange(position_address, direction = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
  }
  pos.out_of_range_direction = direction || pos.out_of_range_direction || null;
  save(state);
  log("state", `Position ${position_address} marked out of range${pos.out_of_range_direction ? ` (${pos.out_of_range_direction})` : ""}`);
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
    pos.out_of_range_direction = null;
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
  cycle_id = null,
  cycle_type,
  status = "completed",
  summary = {},
  candidates = [],
  positions = [],
}) {
  const state = load();
  recordCycleEvaluationInState(state, {
		cycle_id,
		cycle_type,
		status,
		summary,
		candidates,
		positions,
	});

  save(state);
}

export function recordToolOutcome({ tool, outcome, reason = null, metadata = null }) {
  const state = load();
  recordToolOutcomeInState(state, { tool, outcome, reason, metadata });

  save(state);
}

export function getEvaluationSummary(limit = 5) {
  const state = load();
  return getEvaluationSummaryFromState(state, limit);
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
export function updatePnlAndCheckExits(position_address, currentPnlPct, config, { stale = false } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const exitEvaluation = evaluateTrackedPositionExit({
    positionState: pos,
    currentPnlPct,
    managementConfig: config.management,
    stale,
  });

  pos.peak_pnl_pct = exitEvaluation.peak_pnl_pct;
  pos.trailing_active = exitEvaluation.trailing_active;
  if (exitEvaluation.notes.length > 0) {
    pos.notes.push(...exitEvaluation.notes);
  }
  if (exitEvaluation.log_message) {
    log("state", `Position ${position_address} ${exitEvaluation.log_message}`);
  }

  save(state);
  return exitEvaluation.action;
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
      out_of_range_direction: p.out_of_range_direction || null,
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

  const journal = readActionJournal();
  const unresolvedWriteWorkflows = foldActionJournal(journal.entries).filter((workflow) => {
    if (!workflow || !workflow.tool) return false;
    if (workflow.lifecycle === "completed" || workflow.lifecycle === "manual_review") return false;
    return workflow.lifecycle === "intent" || workflow.lifecycle === "close_observed_pending_redeploy";
  });

  if (journal.parse_errors.length > 0) {
    log("state_warn", `State sync skipped auto-close because action journal has ${journal.parse_errors.length} parse error(s)`);
  }

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    if (journal.parse_errors.length > 0) {
      log("state_warn", `Position ${posId} missing on-chain but action journal is invalid; skipping auto-close`);
      continue;
    }

    const relatedWorkflows = unresolvedWriteWorkflows.filter((workflow) => {
      if (workflow.position_address && workflow.position_address === posId) return true;
      if (workflow.pool_address && pos.pool && workflow.pool_address === pos.pool) return true;
      return false;
    });

    if (relatedWorkflows.length > 0) {
      const workflowHints = relatedWorkflows
        .slice(0, 3)
        .map((workflow) => `${workflow.workflow_id}:${workflow.tool}:${workflow.lifecycle}`)
        .join(", ");
      log("state_warn", `Position ${posId} missing on-chain but unresolved workflow(s) exist (${workflowHints}); skipping auto-close`);
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
