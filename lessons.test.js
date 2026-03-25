import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("recordPerformance exposes fee and inventory attribution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lessons-test-"));
  const originalCwd = process.cwd();
  const originalUserConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
  const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");

  try {
    process.chdir(tempDir);
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.05, minOrganic: 60 }, null, 2));

    const { recordPerformance, getPerformanceSummary } = await import(`./lessons.js?test=${Date.now()}`);

    await recordPerformance({
      position: "pos-1",
      pool: "pool-1",
      pool_name: "Alpha-SOL",
      strategy: "bid_ask",
      bin_range: { min: 10, max: 20 },
      bin_step: 85,
      volatility: 4,
      fee_tvl_ratio: 0.22,
      organic_score: 82,
      amount_sol: 1,
      fees_earned_usd: 12,
      final_value_usd: 110,
      initial_value_usd: 100,
      minutes_in_range: 90,
      minutes_held: 120,
      close_reason: "rebalance",
      claim_count: 1,
      rebalance_count: 1,
    });

    const summary = getPerformanceSummary();
    assert.equal(summary.total_positions_closed, 1);
    assert.equal(summary.total_inventory_pnl_usd, 10);
    assert.equal(summary.total_fee_component_usd, 12);
    assert.equal(summary.avg_operational_touch_count, 3);
  } finally {
    process.chdir(originalCwd);
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evolveThresholds writes current screening keys only", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-evolve-test-"));
  const originalUserConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
  const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");

  try {
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.05, minOrganic: 60 }, null, 2));
    fs.writeFileSync(lessonsPath, JSON.stringify({ lessons: [], performance: [] }, null, 2));

    const { config } = await import(`./config.js?test=${Date.now()}`);
    const { evolveThresholds } = await import(`./lessons.js?test=${Date.now()}`);

    const perfData = [
      { pnl_pct: 8, fee_tvl_ratio: 0.30, organic_score: 84 },
      { pnl_pct: 5, fee_tvl_ratio: 0.28, organic_score: 82 },
      { pnl_pct: -8, fee_tvl_ratio: 0.03, organic_score: 58 },
      { pnl_pct: -6, fee_tvl_ratio: 0.04, organic_score: 55 },
      { pnl_pct: -1, fee_tvl_ratio: 0.05, organic_score: 57 },
    ];

    const result = evolveThresholds(perfData, config);
    assert.ok(result.changes.minFeeActiveTvlRatio > 0.05);
    assert.ok(result.changes.minOrganic > 60);
    assert.equal(result.changes.minFeeTvlRatio, undefined);
    assert.equal(result.changes.maxVolatility, undefined);

    const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    assert.ok(persisted.minFeeActiveTvlRatio > 0.05);
    assert.ok(persisted.minOrganic > 60);
    assert.equal(persisted.minFeeTvlRatio, undefined);
    assert.equal(persisted.maxVolatility, undefined);
  } finally {
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
