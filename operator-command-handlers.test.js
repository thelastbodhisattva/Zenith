import assert from "node:assert/strict";
import test from "node:test";

import { handleOperatorCommandText } from "./operator-command-handlers.js";
import {
	getAutonomousWriteSuppression as getExecutorSuppression,
	setAutonomousWriteSuppression as setExecutorSuppression,
} from "./tools/executor.js";

test("operator command handler blocks resume on journal invalid", async () => {
  const result = await handleOperatorCommandText({
    text: "/resume operator approved",
    source: "test",
    config: { protections: { recoveryResumeOverrideMinutes: 120 } },
    getRecoveryWorkflowReport: () => ({ status: "journal_invalid" }),
    getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "manual review required" }),
    clearPortfolioGuardPause: () => ({ cleared: false }),
    setAutonomousWriteSuppression: () => {},
    acknowledgeRecoveryResume: () => ({ override_until: null }),
    armGeneralWriteTools: () => ({ armed_until: null }),
    disarmGeneralWriteTools: () => ({ armed: false }),
    getOperatorControlSnapshot: () => ({
      general_write_arm: { armed: false, armed_until: null },
      recovery_resume_override: { active: false, override_until: null },
    }),
    refreshRuntimeHealth: () => {},
  });

  assert.equal(result.handled, true);
  assert.match(result.message, /cannot resume while the action journal is invalid/i);
});

test("operator command handler arms writes and reports window", async () => {
	const result = await handleOperatorCommandText({
		text: "/arm 7 tool=deploy_position pool=pool-1 testing",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
    getRecoveryWorkflowReport: () => ({ status: "clear" }),
    getAutonomousWriteSuppression: () => ({ suppressed: false, reason: null }),
    clearPortfolioGuardPause: () => ({ cleared: false }),
    setAutonomousWriteSuppression: () => {},
    acknowledgeRecoveryResume: () => ({ override_until: null }),
		armGeneralWriteTools: ({ minutes, scope }) => ({ armed_until: `until+${minutes}`, scope }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: true, armed_until: "until+7", scope: { allowed_tools: ["deploy_position"], pool_address: "pool-1" } },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.match(result.message, /armed for 7 minute\(s\)/i);
	assert.match(result.message, /tools=deploy_position/i);
});

test("operator command handler rejects unscoped arm requests", async () => {
	const result = await handleOperatorCommandText({
		text: "/arm 7 testing",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "clear" }),
		getAutonomousWriteSuppression: () => ({ suppressed: false }),
		setAutonomousWriteSuppression: () => {},
		acknowledgeRecoveryResume: () => ({ override_until: null }),
		armGeneralWriteTools: () => ({ armed_until: null }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: false, armed_until: null },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.match(result.message, /require at least one explicit tool/i);
});

test("operator command handler parses scoped arm options", async () => {
	let receivedScope = null;
	await handleOperatorCommandText({
		text: "/arm 5 tool=deploy_position pool=pool-1 max_sol=0.5 once scoped deploy",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "clear" }),
		getAutonomousWriteSuppression: () => ({ suppressed: false }),
		setAutonomousWriteSuppression: () => {},
		acknowledgeRecoveryResume: () => ({ override_until: null }),
		armGeneralWriteTools: ({ scope }) => {
			receivedScope = scope;
			return { armed_until: "until+5", scope };
		},
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: true, armed_until: "until+5", scope: receivedScope },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});
	assert.deepEqual(receivedScope, {
		allowed_tools: ["deploy_position"],
		pool_address: "pool-1",
		max_amount_sol: 0.5,
		one_shot: true,
	});
});

test("operator resume clears suppression without clearing portfolio guard pause", async () => {
	let suppressionCleared = false;
	let guardCleared = false;
	const result = await handleOperatorCommandText({
		text: "/resume manual review complete",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required", incident_key: "wf-1|wf-2" }),
		getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "manual review required", code: "UNRESOLVED_WORKFLOW", incident_key: "wf-1|wf-2" }),
		clearPortfolioGuardPause: () => {
			guardCleared = true;
			return { cleared: true };
		},
		setAutonomousWriteSuppression: ({ suppressed }) => {
			suppressionCleared = suppressed === false;
		},
		acknowledgeRecoveryResume: ({ incident_key }) => ({ override_until: "until+120", incident_key }),
		armGeneralWriteTools: () => ({ armed_until: null }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: false, armed_until: null },
			recovery_resume_override: { active: true, override_until: "until+120" },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.equal(suppressionCleared, true);
	assert.equal(guardCleared, false);
	assert.match(result.message, /portfolio guard pause unchanged/i);
});

test("operator resume keeps suppression active when durable override persistence fails", async () => {
	let suppressionCleared = false;
	const result = await handleOperatorCommandText({
		text: "/resume manual review complete",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required", incident_key: "wf-1|wf-2" }),
		getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "manual review required", code: "UNRESOLVED_WORKFLOW", incident_key: "wf-1|wf-2" }),
		setAutonomousWriteSuppression: ({ suppressed }) => {
			suppressionCleared = suppressed === false;
		},
		acknowledgeRecoveryResume: () => {
			throw new Error("disk full");
		},
		armGeneralWriteTools: () => ({ armed_until: null }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: false, armed_until: null },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.equal(suppressionCleared, false);
	assert.match(result.message, /cannot persist resume override: disk full/i);
});

test("operator resume only unsuppresses until override expiry in-process", async () => {
	const originalDateNow = Date.now;
	try {
		let now = Date.parse("2030-01-01T00:00:00.000Z");
		Date.now = () => now;
		setExecutorSuppression({ suppressed: true, reason: "manual review required", code: "UNRESOLVED_WORKFLOW", incidentKey: "wf-1" });
		await handleOperatorCommandText({
			text: "/resume ok",
			source: "test",
			config: { protections: { recoveryResumeOverrideMinutes: 1 } },
			getRecoveryWorkflowReport: () => ({ status: "manual_review_required", incident_key: "wf-1" }),
			getAutonomousWriteSuppression: getExecutorSuppression,
			setAutonomousWriteSuppression: setExecutorSuppression,
			acknowledgeRecoveryResume: () => ({ override_until: new Date(now + 60_000).toISOString(), incident_key: "wf-1" }),
			armGeneralWriteTools: () => ({ armed_until: null }),
			disarmGeneralWriteTools: () => ({ armed: false }),
			getOperatorControlSnapshot: () => ({ general_write_arm: { armed: false }, recovery_resume_override: { active: true, override_until: new Date(now + 60_000).toISOString() } }),
			refreshRuntimeHealth: () => {},
		});
		now += 120_000;
		assert.equal(getExecutorSuppression().suppressed, true);
	} finally {
		setExecutorSuppression({ suppressed: false });
		Date.now = originalDateNow;
	}
});

test("operator resume rejects incident-key mismatch between report and suppression", async () => {
	let acknowledgeCalled = false;
	const result = await handleOperatorCommandText({
		text: "/resume manual review complete",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required", incident_key: "wf-other" }),
		getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "manual review required", code: "UNRESOLVED_WORKFLOW", incident_key: "wf-1|wf-2" }),
		setAutonomousWriteSuppression: () => {},
		acknowledgeRecoveryResume: () => {
			acknowledgeCalled = true;
			return { override_until: null };
		},
		armGeneralWriteTools: () => ({ armed_until: null }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: false, armed_until: null },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.equal(acknowledgeCalled, false);
	assert.match(result.message, /cannot persist resume override unless autonomous writes are currently suppressed/i);
});

test("operator resume blocks override when suppression is not an unresolved-workflow boot block", async () => {
	let acknowledgeCalled = false;
	const result = await handleOperatorCommandText({
		text: "/resume manual review complete",
		source: "test",
		config: { protections: { recoveryResumeOverrideMinutes: 120 } },
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required" }),
		getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "open-position observation invalid (rpc unavailable)", code: "OPEN_POSITIONS_INVALID", incident_key: null }),
		setAutonomousWriteSuppression: () => {},
		acknowledgeRecoveryResume: () => {
			acknowledgeCalled = true;
			return { override_until: null };
		},
		armGeneralWriteTools: () => ({ armed_until: null }),
		disarmGeneralWriteTools: () => ({ armed: false }),
		getOperatorControlSnapshot: () => ({
			general_write_arm: { armed: false, armed_until: null },
			recovery_resume_override: { active: false, override_until: null },
		}),
		refreshRuntimeHealth: () => {},
	});

	assert.equal(result.handled, true);
	assert.equal(acknowledgeCalled, false);
	assert.match(result.message, /cannot persist resume override unless autonomous writes are currently suppressed/i);
});
