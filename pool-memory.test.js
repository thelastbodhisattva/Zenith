import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_LOW_YIELD_REASON,
  getNegativeRegimeCooldown,
  getPoolDeployCooldown,
  isLowYieldCloseReason,
  recordPoolDeploy,
} from "./pool-memory.js";

test("recordPoolDeploy sets 4h cooldown for canonical low-yield closes", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-pool-memory-test-"));

  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });

    recordPoolDeploy("pool-1", {
      pool_name: "Pool One",
      close_reason: "fee yield too low",
      pnl_pct: -1,
    });

    const active = getPoolDeployCooldown({ pool_address: "pool-1" });
    assert.equal(active.active, true);
    assert.equal(active.reason, CANONICAL_LOW_YIELD_REASON);
    assert.ok(active.remaining_ms > 0);

    const afterFiveHours = getPoolDeployCooldown({
      pool_address: "pool-1",
      nowMs: Date.now() + (5 * 60 * 60 * 1000),
    });
    assert.equal(afterFiveHours.active, false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isLowYieldCloseReason matches canonical reason only", () => {
  assert.equal(isLowYieldCloseReason("fee yield too low"), true);
  assert.equal(isLowYieldCloseReason("fee_yield_too_low"), true);
  assert.equal(isLowYieldCloseReason("manual close by operator"), false);
});

test("recordPoolDeploy stores deterministic negative regime cooldown keys", () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-pool-regime-cooldown-test-"));

  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });

    recordPoolDeploy("pool-2", {
      pool_name: "Pool Two",
      close_reason: "stop loss",
      pnl_pct: -9,
      strategy: "bid_ask",
      regime_label: "defensive",
    });

    const cooldown = getNegativeRegimeCooldown({
      pool_address: "pool-2",
      regime_label: "defensive",
      strategy: "bid_ask",
    });
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.key, "defensive|bid_ask");
    assert.ok(cooldown.remaining_ms > 0);
    assert.equal(cooldown.hits, 1);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
