import assert from "node:assert/strict";
import test from "node:test";

import {
	markSlowManagementReview,
	resetSlowManagementReviewForTests,
	shouldRunSlowManagementReview,
} from "./management-review-window.js";

test.afterEach(() => {
	resetSlowManagementReviewForTests();
});

test("slow management review only becomes due after the configured interval", () => {
	const start = Date.parse("2030-01-01T00:00:00.000Z");
	assert.equal(shouldRunSlowManagementReview({ nowMs: start, intervalMs: 15 * 60_000 }), true);
	markSlowManagementReview({ nowMs: start });
	assert.equal(shouldRunSlowManagementReview({ nowMs: start + 5 * 60_000, intervalMs: 15 * 60_000 }), false);
	assert.equal(shouldRunSlowManagementReview({ nowMs: start + 16 * 60_000, intervalMs: 15 * 60_000 }), true);
});
