import fs from "node:fs";
import path from "node:path";

const DATA_DIR = "./data";
const ACTIONS_FILE = path.join(DATA_DIR, "operator-actions.jsonl");
const STATE_FILE = path.join(DATA_DIR, "operator-state.json");

function emptyState() {
  return {
    general_write_arm_until_ms: 0,
    general_write_arm_reason: null,
    recovery_resume_override_until_ms: 0,
    recovery_resume_override_reason: null,
    recovery_resume_override_source: null,
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    return {
      ...emptyState(),
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")),
    };
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendOperatorAction(entry) {
  ensureDataDir();
  fs.appendFileSync(ACTIONS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export function armGeneralWriteTools({ minutes = 10, reason = "manual operator arm", nowMs = Date.now() } = {}) {
  const state = loadState();
  state.general_write_arm_until_ms = nowMs + (Number(minutes) || 10) * 60_000;
  state.general_write_arm_reason = reason;
  saveState(state);
  appendOperatorAction({ type: "arm_general_writes", minutes, reason, armed_until: new Date(state.general_write_arm_until_ms).toISOString() });
  return getGeneralWriteArmStatus({ nowMs });
}

export function disarmGeneralWriteTools({ reason = "manual operator disarm", nowMs = Date.now() } = {}) {
  const state = loadState();
  const wasArmed = state.general_write_arm_until_ms > nowMs;
  state.general_write_arm_until_ms = 0;
  state.general_write_arm_reason = null;
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
  };
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
  };
}

export function getOperatorControlSnapshot({ nowMs = Date.now(), recentActionLimit = 5 } = {}) {
  return {
    general_write_arm: getGeneralWriteArmStatus({ nowMs }),
    recovery_resume_override: getRecoveryResumeOverrideStatus({ nowMs }),
    recent_actions: listOperatorActions(recentActionLimit),
  };
}

export function clearRecoveryResumeOverride({ reason = "operator clear", nowMs = Date.now() } = {}) {
  const state = loadState();
  const wasActive = Number(state.recovery_resume_override_until_ms || 0) > nowMs;
  state.recovery_resume_override_until_ms = 0;
  state.recovery_resume_override_reason = null;
  state.recovery_resume_override_source = null;
  saveState(state);
  appendOperatorAction({ type: "clear_recovery_resume_override", reason, was_active: wasActive });
  return getRecoveryResumeOverrideStatus({ nowMs });
}

export function acknowledgeRecoveryResume({
  reason,
  source = "operator",
  report_status = null,
  cleared_guard_pause = false,
  override_minutes = 180,
  nowMs = Date.now(),
} = {}) {
  const state = loadState();
  state.recovery_resume_override_until_ms = nowMs + Math.max(1, Number(override_minutes) || 180) * 60_000;
  state.recovery_resume_override_reason = reason || "manual resume";
  state.recovery_resume_override_source = source;
  saveState(state);

  appendOperatorAction({
    type: "resume_autonomous_writes",
    reason: state.recovery_resume_override_reason,
    source,
    report_status,
    cleared_guard_pause,
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
