import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "./prompt.js";

test("screener prompt prefers get_top_candidates and keeps interval tuning runtime-owned", () => {
  const prompt = buildSystemPrompt(
    "SCREENER",
    { sol: 1.2, tokens: [] },
    { total_positions: 0, positions: [] },
    { recent_events: [], evaluation: null },
    null,
    null,
    null,
  );

  assert.ok(prompt.includes("Use get_top_candidates as the primary screening tool"));
  assert.ok(prompt.includes("SCHEDULING IS RUNTIME-OWNED"));
  assert.ok(!prompt.includes("managementIntervalMin: 3"));
  assert.ok(!prompt.includes("management.managementIntervalMin"));
});

test("prompt surfaces invalid performance state explicitly", () => {
	const prompt = buildSystemPrompt(
		"SCREENER",
		{ sol: 1.2, tokens: [] },
		{ total_positions: 0, positions: [] },
		{ recent_events: [], evaluation: null },
		"[INVALID LESSONS STATE] lessons unreadable",
		{ invalid_state: true, error: "lessons unreadable" },
		null,
	);

	assert.ok(prompt.includes("INVALID PERFORMANCE STATE: lessons unreadable"));
	assert.ok(prompt.includes("INVALID LESSONS STATE"));
});
