import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendReplayEnvelope } from "./cycle-trace.js";
import { getReplayReview, getReplayReviewStats } from "./replay-review.js";

test("replay review finds envelope and reports deterministic match", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-replay-review-test-"));

  try {
    process.chdir(tempDir);
    fs.mkdirSync("logs", { recursive: true });

    appendReplayEnvelope({
      cycle_id: "management-review-1",
      cycle_type: "management",
      position_inputs: [],
      runtime_actions: [],
    });

    const review = getReplayReview("management-review-1");
    assert.equal(review.found, true);
    assert.equal(review.reconciliation.status, "match");

    const stats = getReplayReviewStats(10);
    assert.equal(stats.total, 1);
    assert.equal(stats.matches, 1);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("replay review supports deterministic screening skip envelopes", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-replay-review-skip-test-"));

	try {
		process.chdir(tempDir);
		fs.mkdirSync("logs", { recursive: true });

		appendReplayEnvelope({
			cycle_id: "screening-skip-1",
			cycle_type: "screening",
			status: "skipped_max_positions",
			summary: {
				total_positions: 3,
				max_positions: 3,
			},
			admission_inputs: {
				positionsCount: 3,
				walletSol: 10,
				config: {
					risk: { maxPositions: 3 },
					management: { deployAmountSol: 0.5, gasReserve: 0.1 },
				},
			},
		});

		const review = getReplayReview("screening-skip-1");
		assert.equal(review.found, true);
		assert.equal(review.reconciliation.status, "match");
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("replay review surfaces parse errors while keeping valid envelopes readable", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-replay-review-parse-test-"));

	try {
		process.chdir(tempDir);
		fs.mkdirSync("logs", { recursive: true });
		fs.writeFileSync(path.join("logs", "replay-2026-03-27.jsonl"), `${JSON.stringify({ cycle_id: "management-review-2", cycle_type: "management", position_inputs: [], runtime_actions: [] })}\n{bad json\n`);

		const review = getReplayReview("management-review-2");
		assert.equal(review.found, true);
		assert.equal(review.reconciliation.status, "match");
		assert.equal(review.parse_errors.length, 1);

		const missing = getReplayReview("missing");
		assert.equal(missing.found, false);
		assert.equal(missing.parse_errors.length, 1);

		const stats = getReplayReviewStats(10);
		assert.equal(stats.parse_errors, 1);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
