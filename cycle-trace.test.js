import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	appendReplayEnvelope,
	createActionId,
	createCycleId,
	readReplayEnvelopeReport,
	readReplayEnvelopes,
} from "./cycle-trace.js";

test("cycle trace creates stable ids and writes replay envelopes", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-trace-test-"));

  try {
    process.chdir(tempDir);
    const cycleId = createCycleId("screening");
    const actionId = createActionId(cycleId, "deploy_position", 0);
    appendReplayEnvelope({
      cycle_id: cycleId,
      cycle_type: "screening",
      shortlist: [{ pool: "pool-a", ranking_score: 88.1 }],
    });

    assert.match(cycleId, /^screening-/);
    assert.equal(actionId, `${cycleId}:deploy_position:1`);

    const logDir = path.join(tempDir, "logs");
    const replayFiles = fs.readdirSync(logDir).filter((file) => file.startsWith("replay-"));
    assert.equal(replayFiles.length, 1);

    const replayContent = fs.readFileSync(path.join(logDir, replayFiles[0]), "utf8").trim();
    const parsed = JSON.parse(replayContent);
    assert.equal(parsed.cycle_id, cycleId);
    assert.equal(parsed.cycle_type, "screening");
    assert.equal(parsed.shortlist[0].pool, "pool-a");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cycle trace fails loudly on malformed replay lines", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-trace-invalid-test-"));

	try {
		process.chdir(tempDir);
		const logDir = path.join(tempDir, "logs");
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, "replay-2026-03-27.jsonl"), "{bad json\n");
		assert.throws(() => readReplayEnvelopes(), /invalid replay envelope/i);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cycle trace can report parse errors without dropping valid envelopes", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-trace-parse-report-test-"));

	try {
		process.chdir(tempDir);
		const logDir = path.join(tempDir, "logs");
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, "replay-2026-03-27.jsonl"), `${JSON.stringify({ cycle_id: "ok-1", cycle_type: "screening" })}\n{bad json\n`);
		const report = readReplayEnvelopeReport();
		assert.equal(report.envelopes.length, 1);
		assert.equal(report.envelopes[0].cycle_id, "ok-1");
		assert.equal(report.parse_errors.length, 1);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
