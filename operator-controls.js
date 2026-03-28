import fs from "node:fs";
import path from "node:path";

import {
	appendJsonlRecordSync,
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";

const DATA_DIR = "./data";
const ACTIONS_FILE = path.join(DATA_DIR, "operator-actions.jsonl");
const STATE_FILE = path.join(DATA_DIR, "operator-state.json");

function emptyState() {
  return {
    general_write_arm_until_ms: 0,
    general_write_arm_reason: null,
    general_write_arm_scope: null,
    recovery_resume_override_until_ms: 0,
    recovery_resume_override_reason: null,
    recovery_resume_override_source: null,
    recovery_resume_override_incident_key: null,
  };
}

function normalizeGeneralWriteScope(scope = {}) {
	if (!scope || typeof scope !== "object") return null;
	const tools = Array.isArray(scope.allowed_tools)
		? scope.allowed_tools.filter(Boolean)
		: typeof scope.allowed_tools === "string"
			? scope.allowed_tools.split(",").map((tool) => tool.trim()).filter(Boolean)
			: [];
	const maxAmountSol = scope.max_amount_sol == null ? null : Number(scope.max_amount_sol);
	return {
		allowed_tools: tools.length > 0 ? tools : null,
		pool_address: scope.pool_address || null,
		position_address: scope.position_address || null,
		max_amount_sol: Number.isFinite(maxAmountSol) && maxAmountSol >= 0 ? maxAmountSol : null,
		one_shot: Boolean(scope.one_shot),
	};
}

function clearGeneralWriteScope(state) {
	state.general_write_arm_scope = null;
}

function loadState() {
	const snapshot = readJsonSnapshotWithBackupSync(STATE_FILE);
	if (!snapshot.value) {
		if (!snapshot.error) return emptyState();
		return {
			...emptyState(),
			_invalid_state: true,
			_error: snapshot.error,
		};
	}
	return {
		...emptyState(),
		...snapshot.value,
		_loaded_from_backup: snapshot.source === "backup",
	};
}

function saveState(state) {
	writeJsonSnapshotAtomicSync(STATE_FILE, state);
}

function appendOperatorAction(entry) {
	appendJsonlRecordSync(ACTIONS_FILE, {
		ts: new Date().toISOString(),
		...entry,
	});
}

export function recordOperatorAction(entry = {}) {
	appendOperatorAction(entry);
}

export function armGeneralWriteTools({ minutes = 10, reason = "manual operator arm", scope = null, nowMs = Date.now() } = {}) {
  const state = loadState();
  state.general_write_arm_until_ms = nowMs + (Number(minutes) || 10) * 60_000;
  state.general_write_arm_reason = reason;
  state.general_write_arm_scope = normalizeGeneralWriteScope(scope);
  saveState(state);
  appendOperatorAction({
		type: "arm_general_writes",
		minutes,
		reason,
		scope: state.general_write_arm_scope,
		armed_until: new Date(state.general_write_arm_until_ms).toISOString(),
	});
  return getGeneralWriteArmStatus({ nowMs });
}

export function disarmGeneralWriteTools({ reason = "manual operator disarm", nowMs = Date.now() } = {}) {
  const state = loadState();
  const wasArmed = state.general_write_arm_until_ms > nowMs;
  state.general_write_arm_until_ms = 0;
  state.general_write_arm_reason = null;
  clearGeneralWriteScope(state);
  saveState(state);
  appendOperatorAction({ type: "disarm_general_writes", reason, was_armed: wasArmed });
  return getGeneralWriteArmStatus({ nowMs });
}

export function getGeneralWriteArmStatus({ nowMs = Date.now() } = {}) {
	const state = loadState();
	const remainingMs = Math.max(0, Number(state.general_write_arm_until_ms || 0) - nowMs);
	return {
    armed: remainingMs > 0,
    armed_until: remainingMs > 0 ? new Date(state.general_write_arm_until_ms).toISOString() : null,
		remaining_ms: remainingMs,
		reason: remainingMs > 0 ? state.general_write_arm_reason : null,
		scope: remainingMs > 0 ? state.general_write_arm_scope : null,
		invalid_state: Boolean(state._invalid_state),
		loaded_from_backup: Boolean(state._loaded_from_backup),
	};
}

export function evaluateGeneralWriteApproval({
	tool_name,
	pool_address = null,
	position_address = null,
	amount_sol = null,
	nowMs = Date.now(),
} = {}) {
	const arm = getGeneralWriteArmStatus({ nowMs });
	if (!arm.armed) {
		return {
			pass: false,
			reason_code: "GENERAL_WRITE_NOT_ARMED",
			reason: "GENERAL write approval is not armed.",
		};
	}

	const scope = arm.scope || {};
	if (Array.isArray(scope.allowed_tools) && scope.allowed_tools.length > 0 && !scope.allowed_tools.includes(tool_name)) {
		return {
			pass: false,
			reason_code: "GENERAL_WRITE_TOOL_SCOPE_MISMATCH",
			reason: `GENERAL approval does not include tool ${tool_name}.`,
		};
	}
	if (scope.pool_address && scope.pool_address !== pool_address) {
		return {
			pass: false,
			reason_code: "GENERAL_WRITE_POOL_SCOPE_MISMATCH",
			reason: `GENERAL approval is scoped to pool ${scope.pool_address}.`,
		};
	}
	if (scope.position_address && scope.position_address !== position_address) {
		return {
			pass: false,
			reason_code: "GENERAL_WRITE_POSITION_SCOPE_MISMATCH",
			reason: `GENERAL approval is scoped to position ${scope.position_address}.`,
		};
	}
	if (scope.max_amount_sol != null && Number(amount_sol) > scope.max_amount_sol) {
		return {
			pass: false,
			reason_code: "GENERAL_WRITE_MAX_NOTIONAL_EXCEEDED",
			reason: `GENERAL approval max notional is ${scope.max_amount_sol} SOL.`,
		};
	}

	return {
		pass: true,
		reason_code: null,
		reason: null,
		scope,
		armed_until: arm.armed_until,
	};
}

export function consumeOneShotGeneralWriteApproval({
	tool_name,
	pool_address = null,
	position_address = null,
	amount_sol = null,
	nowMs = Date.now(),
} = {}) {
	const state = loadState();
	const scope = normalizeGeneralWriteScope(state.general_write_arm_scope);
	const remainingMs = Math.max(0, Number(state.general_write_arm_until_ms || 0) - nowMs);
	if (remainingMs <= 0 || !scope?.one_shot) {
		return getGeneralWriteArmStatus({ nowMs });
	}
	const approval = evaluateGeneralWriteApproval({
		tool_name,
		pool_address,
		position_address,
		amount_sol,
		nowMs,
	});
	if (!approval.pass) {
		return getGeneralWriteArmStatus({ nowMs });
	}
	state.general_write_arm_until_ms = 0;
	state.general_write_arm_reason = null;
	clearGeneralWriteScope(state);
	saveState(state);
	appendOperatorAction({
		type: "consume_general_write_approval",
		tool_name,
		pool_address,
		position_address,
		amount_sol,
	});
	return getGeneralWriteArmStatus({ nowMs });
}

export function getRecoveryResumeOverrideStatus({ nowMs = Date.now() } = {}) {
  const state = loadState();
  const remainingMs = Math.max(0, Number(state.recovery_resume_override_until_ms || 0) - nowMs);
	return {
		active: remainingMs > 0,
		override_until: remainingMs > 0 ? new Date(state.recovery_resume_override_until_ms).toISOString() : null,
		remaining_ms: remainingMs,
		reason: remainingMs > 0 ? state.recovery_resume_override_reason : null,
		source: remainingMs > 0 ? state.recovery_resume_override_source : null,
		incident_key: remainingMs > 0 ? state.recovery_resume_override_incident_key : null,
		invalid_state: Boolean(state._invalid_state),
		loaded_from_backup: Boolean(state._loaded_from_backup),
	};
}

export function getOperatorControlSnapshot({ nowMs = Date.now(), recentActionLimit = 5 } = {}) {
	const state = loadState();
  return {
    general_write_arm: getGeneralWriteArmStatus({ nowMs }),
    recovery_resume_override: getRecoveryResumeOverrideStatus({ nowMs }),
    recent_actions: listOperatorActions(recentActionLimit),
		invalid_state: Boolean(state._invalid_state),
		loaded_from_backup: Boolean(state._loaded_from_backup),
		parse_error: state._error || null,
  };
}

export function clearRecoveryResumeOverride({ reason = "operator clear", nowMs = Date.now() } = {}) {
  const state = loadState();
  const wasActive = Number(state.recovery_resume_override_until_ms || 0) > nowMs;
  state.recovery_resume_override_until_ms = 0;
  state.recovery_resume_override_reason = null;
  state.recovery_resume_override_source = null;
  state.recovery_resume_override_incident_key = null;
  saveState(state);
  appendOperatorAction({ type: "clear_recovery_resume_override", reason, was_active: wasActive });
  return getRecoveryResumeOverrideStatus({ nowMs });
}

export function acknowledgeRecoveryResume({
  reason,
  source = "operator",
  report_status = null,
  cleared_guard_pause = false,
  incident_key = null,
  override_minutes = 180,
  nowMs = Date.now(),
} = {}) {
  const state = loadState();
  state.recovery_resume_override_until_ms = nowMs + Math.max(1, Number(override_minutes) || 180) * 60_000;
  state.recovery_resume_override_reason = reason || "manual resume";
  state.recovery_resume_override_source = source;
  state.recovery_resume_override_incident_key = incident_key;
  saveState(state);

  appendOperatorAction({
    type: "resume_autonomous_writes",
    reason: state.recovery_resume_override_reason,
    source,
    report_status,
    cleared_guard_pause,
    incident_key,
    override_minutes,
    override_until: new Date(state.recovery_resume_override_until_ms).toISOString(),
  });

  return getRecoveryResumeOverrideStatus({ nowMs });
}

export function listOperatorActions(limit = 20) {
  if (!fs.existsSync(ACTIONS_FILE)) return [];
  return fs.readFileSync(ACTIONS_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}
