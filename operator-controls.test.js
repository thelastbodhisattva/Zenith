import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acknowledgeRecoveryResume,
  armGeneralWriteTools,
  consumeOneShotGeneralWriteApproval,
  disarmGeneralWriteTools,
  evaluateGeneralWriteApproval,
  getGeneralWriteArmStatus,
  getOperatorControlSnapshot,
  getRecoveryResumeOverrideStatus,
  listOperatorActions,
} from "./operator-controls.js";

test("operator controls arm and audit general write access", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-operator-controls-test-"));

  try {
    process.chdir(tempDir);
    const armed = armGeneralWriteTools({ minutes: 5, reason: "test arm" });
    assert.equal(armed.armed, true);
    assert.equal(getGeneralWriteArmStatus().armed, true);

    acknowledgeRecoveryResume({ reason: "test resume", report_status: "manual_review_required" });
    disarmGeneralWriteTools({ reason: "test disarm" });
    assert.equal(getGeneralWriteArmStatus().armed, false);

    const actions = listOperatorActions(5);
    assert.equal(actions.length >= 3, true);
    assert.equal(actions[0].type, "disarm_general_writes");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("operator controls persist arm and resume override state across reload-style calls", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-operator-controls-persist-test-"));
  const nowMs = Date.now();

  try {
    process.chdir(tempDir);

    armGeneralWriteTools({ minutes: 2, reason: "persist arm", nowMs });
    const armStatus = getGeneralWriteArmStatus({ nowMs: nowMs + 60_000 });
    assert.equal(armStatus.armed, true);
    assert.match(armStatus.reason || "", /persist arm/i);

    acknowledgeRecoveryResume({
      reason: "manual review complete",
      source: "test",
      incident_key: "wf-1|wf-2",
      override_minutes: 30,
      nowMs,
    });

    const overrideStatus = getRecoveryResumeOverrideStatus({ nowMs: nowMs + 5 * 60_000 });
    assert.equal(overrideStatus.active, true);
    assert.match(overrideStatus.reason || "", /manual review complete/i);
    assert.equal(overrideStatus.source, "test");
    assert.equal(overrideStatus.incident_key, "wf-1|wf-2");

    const snapshot = getOperatorControlSnapshot({ nowMs: nowMs + 5 * 60_000, recentActionLimit: 2 });
    assert.equal(snapshot.general_write_arm.armed, false);
    assert.equal(snapshot.recovery_resume_override.active, true);
    assert.equal(snapshot.recent_actions.length > 0, true);

    const stateRaw = JSON.parse(fs.readFileSync(path.join(tempDir, "data", "operator-state.json"), "utf8"));
    assert.equal(stateRaw.general_write_arm_reason, "persist arm");
    assert.equal(typeof stateRaw.recovery_resume_override_until_ms, "number");
    assert.equal(stateRaw.recovery_resume_override_incident_key, "wf-1|wf-2");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("operator controls enforce scoped GENERAL write approval", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-operator-controls-scope-test-"));
	const nowMs = Date.now();

	try {
		process.chdir(tempDir);
		armGeneralWriteTools({
			minutes: 5,
			reason: "scoped deploy arm",
			scope: {
				allowed_tools: ["deploy_position"],
				pool_address: "pool-1",
				max_amount_sol: 0.5,
				one_shot: true,
			},
			nowMs,
		});

		const allowed = evaluateGeneralWriteApproval({
			tool_name: "deploy_position",
			pool_address: "pool-1",
			amount_sol: 0.5,
			nowMs: nowMs + 60_000,
		});
		assert.equal(allowed.pass, true);
		assert.equal(allowed.scope.one_shot, true);

		const blockedTool = evaluateGeneralWriteApproval({
			tool_name: "close_position",
			pool_address: "pool-1",
			amount_sol: 0.5,
			nowMs: nowMs + 60_000,
		});
		assert.equal(blockedTool.reason_code, "GENERAL_WRITE_TOOL_SCOPE_MISMATCH");

		const blockedPool = evaluateGeneralWriteApproval({
			tool_name: "deploy_position",
			pool_address: "pool-2",
			amount_sol: 0.5,
			nowMs: nowMs + 60_000,
		});
		assert.equal(blockedPool.reason_code, "GENERAL_WRITE_POOL_SCOPE_MISMATCH");

		consumeOneShotGeneralWriteApproval({
			tool_name: "deploy_position",
			pool_address: "pool-1",
			amount_sol: 0.5,
			nowMs: nowMs + 90_000,
		});
		assert.equal(getGeneralWriteArmStatus({ nowMs: nowMs + 90_000 }).armed, false);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("operator controls fail closed on corrupt state and recover from backup", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-operator-controls-backup-test-"));

	try {
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "data", "operator-state.json"), "{bad json");
		const invalid = getOperatorControlSnapshot();
		assert.equal(invalid.invalid_state, true);
		assert.equal(invalid.general_write_arm.armed, false);

		fs.rmSync(path.join(tempDir, "data", "operator-state.json"), { force: true });
		fs.writeFileSync(path.join(tempDir, "data", "operator-state.json.bak"), JSON.stringify({
			general_write_arm_until_ms: Date.now() + 60_000,
			general_write_arm_reason: "backup arm",
		}, null, 2));
		const recovered = getOperatorControlSnapshot();
		assert.equal(recovered.loaded_from_backup, true);
		assert.equal(recovered.general_write_arm.armed, true);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
