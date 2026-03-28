import assert from "node:assert/strict";
import test from "node:test";

import { handleOperatorCommandText } from "./operator-command-handlers.js";

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
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required" }),
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
