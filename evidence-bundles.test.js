import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getEvidenceBundle, listEvidenceBundles, writeEvidenceBundle } from "./evidence-bundles.js";

test("writeEvidenceBundle persists and lists bounded bad-cycle bundles", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-evidence-test-"));

  try {
    process.chdir(tempDir);
    const filePath = writeEvidenceBundle({
      cycle_id: "screening-123",
      cycle_type: "screening",
      status: "failed_candidates",
      reason_code: "INPUT_UNAVAILABLE",
      error: "candidates unavailable",
      written_at: new Date().toISOString(),
    });
    assert.ok(filePath);
    assert.equal(fs.existsSync(filePath), true);

    const listed = listEvidenceBundles(5);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].cycle_id, "screening-123");
    assert.equal(listed[0].incident_key, "screening-123");
    assert.equal(listed[0].reason_code, "INPUT_UNAVAILABLE");
    assert.equal(listed[0].runbook_slug, "runbook-input-unavailable");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("evidence bundles tolerate malformed files and can read from backup", () => {
	const originalCwd = process.cwd();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-evidence-backup-test-"));

	try {
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, "logs", "evidence"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "logs", "evidence", "bad.json"), "{bad json");
		fs.writeFileSync(path.join(tempDir, "logs", "evidence", "screening-456.json.bak"), JSON.stringify({
			cycle_id: "screening-456",
			cycle_type: "screening",
			status: "failed_precheck",
			reason_code: "INPUT_UNAVAILABLE",
		}, null, 2));

		const listed = listEvidenceBundles(5);
		assert.equal(listed.length, 1);
		assert.equal(listed[0].cycle_id, "screening-456");

		const bundle = getEvidenceBundle("screening-456");
		assert.equal(bundle.cycle_id, "screening-456");
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
