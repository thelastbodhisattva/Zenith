import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("memory uses broader strategy buckets for screening recall", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-memory-test-"));
  const originalDir = process.env.ZENITH_MEMORY_DIR;

  try {
    process.env.ZENITH_MEMORY_DIR = tempDir;

    const { buildStrategyMemoryKey, getMemoryContext, initMemory, recallForScreening, rememberStrategy } = await import(`./memory.js?test=${Date.now()}`);
    initMemory();

    rememberStrategy({ strategy: "bid_ask", bin_step: 85 }, "worked well in tight bins");

    const key = buildStrategyMemoryKey("bid_ask", 82);
    assert.equal(key, "strategy-bidask-tight");

    const results = recallForScreening({ bin_step: 84 });
    assert.equal(results.length, 1);
    assert.equal(results[0].key, "strategy-bidask-tight");

    const context = getMemoryContext();
    assert.ok(context.includes("strategy-bidask-tight"));
  } finally {
    if (originalDir) process.env.ZENITH_MEMORY_DIR = originalDir;
    else delete process.env.ZENITH_MEMORY_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
