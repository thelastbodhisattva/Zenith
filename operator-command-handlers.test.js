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
    text: "/arm 7 testing",
    source: "test",
    config: { protections: { recoveryResumeOverrideMinutes: 120 } },
    getRecoveryWorkflowReport: () => ({ status: "clear" }),
    getAutonomousWriteSuppression: () => ({ suppressed: false, reason: null }),
    clearPortfolioGuardPause: () => ({ cleared: false }),
    setAutonomousWriteSuppression: () => {},
    acknowledgeRecoveryResume: () => ({ override_until: null }),
    armGeneralWriteTools: ({ minutes }) => ({ armed_until: `until+${minutes}` }),
    disarmGeneralWriteTools: () => ({ armed: false }),
    getOperatorControlSnapshot: () => ({
      general_write_arm: { armed: true, armed_until: "until+7" },
      recovery_resume_override: { active: false, override_until: null },
    }),
    refreshRuntimeHealth: () => {},
  });

  assert.equal(result.handled, true);
  assert.match(result.message, /armed for 7 minute\(s\)/i);
});
