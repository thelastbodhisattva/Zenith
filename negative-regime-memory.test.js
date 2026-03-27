import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("negative regime memory requires stronger sample quality before activation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-negative-regime-memory-test-"));
  const originalFile = process.env.ZENITH_NEGATIVE_REGIME_MEMORY_FILE;

  try {
    process.env.ZENITH_NEGATIVE_REGIME_MEMORY_FILE = path.join(tempDir, "negative-regime-memory.json");
    const { buildNegativeRegimeMemoryKey, getNegativeRegimeMemory, recordNegativeRegimeOutcome } = await import(`./negative-regime-memory.js?test=${Date.now()}`);

    const first = recordNegativeRegimeOutcome({
      regime_label: "defensive",
      strategy: "bid_ask",
      pnl_pct: -6,
      close_reason: "stop loss",
    });
    assert.equal(first.recorded, true);
    assert.equal(first.sample_quality, "weak");
    assert.equal(first.cooldown_until, null);

    const weak = getNegativeRegimeMemory({ regime_label: "defensive", strategy: "bid_ask" });
    assert.equal(weak.active, false);
    assert.equal(weak.sample_quality, "weak");

    const second = recordNegativeRegimeOutcome({
      regime_label: "defensive",
      strategy: "bid_ask",
      pnl_pct: -7,
      close_reason: "fee yield too low",
    });
    assert.equal(second.key, buildNegativeRegimeMemoryKey({ regime_label: "defensive", strategy: "bid_ask" }));

    const cooldown = getNegativeRegimeMemory({ regime_label: "defensive", strategy: "bid_ask" });
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.hits, 2);
    assert.equal(cooldown.sample_quality, "confirmed");
    assert.ok(cooldown.remaining_ms > 0);
  } finally {
    if (originalFile) process.env.ZENITH_NEGATIVE_REGIME_MEMORY_FILE = originalFile;
    else delete process.env.ZENITH_NEGATIVE_REGIME_MEMORY_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
