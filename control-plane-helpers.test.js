import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessTelegramCommandHandler } from "./control-plane-helpers.js";

test("headless Telegram handler serves /health and /recovery before operator commands", async () => {
	const messages = [];
	const handler = createHeadlessTelegramCommandHandler({
		handleOperatorCommandText: async ({ text }) => ({ handled: text === "/resume ok", message: "resumed" }),
		buildOperationalHealthReport: async () => "health report",
		getRecoveryWorkflowReport: () => ({ status: "manual_review_required" }),
		getAutonomousWriteSuppression: () => ({ suppressed: true, reason: "manual review required" }),
		formatRecoveryReport: (report, suppression) => `recovery ${report.status} ${suppression.reason}`,
		sendMessage: async (value) => messages.push(value),
	});

	await handler("/health");
	await handler("/recovery");
	await handler("/resume ok");
	await handler("hello");

	assert.equal(messages[0], "health report");
	assert.equal(messages[1], "recovery manual_review_required manual review required");
	assert.equal(messages[2], "resumed");
	assert.match(messages[3], /only accepts \/health, \/recovery, and operator commands/i);
});
