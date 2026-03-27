import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acknowledgeRecoveryResume,
  armGeneralWriteTools,
  disarmGeneralWriteTools,
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
      override_minutes: 30,
      nowMs,
    });

    const overrideStatus = getRecoveryResumeOverrideStatus({ nowMs: nowMs + 5 * 60_000 });
    assert.equal(overrideStatus.active, true);
    assert.match(overrideStatus.reason || "", /manual review complete/i);
    assert.equal(overrideStatus.source, "test");

    const snapshot = getOperatorControlSnapshot({ nowMs: nowMs + 5 * 60_000, recentActionLimit: 2 });
    assert.equal(snapshot.general_write_arm.armed, false);
    assert.equal(snapshot.recovery_resume_override.active, true);
    assert.equal(snapshot.recent_actions.length > 0, true);

    const stateRaw = JSON.parse(fs.readFileSync(path.join(tempDir, "data", "operator-state.json"), "utf8"));
    assert.equal(stateRaw.general_write_arm_reason, "persist arm");
    assert.equal(typeof stateRaw.recovery_resume_override_until_ms, "number");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
