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
  const originalRolloutFile = process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");
  const rolloutPath = path.join(tempDir, "threshold-rollout.json");

  try {
    process.chdir(tempDir);
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = rolloutPath;
    fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.05, minOrganic: 60 }, null, 2));

    const { recordPerformance, getPerformanceSummary, getStrategyProofSummary } = await import(`./lessons.js?test=${Date.now()}`);

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
      opened_by_cycle_id: "screening-123",
      opened_by_action_id: "screening-123:deploy_position:1",
      opened_by_workflow_id: "screening-123:deploy_position:1",
      closed_by_cycle_id: "management-456",
      closed_by_action_id: "management-456:close_position:1",
      closed_by_workflow_id: "management-456:close_position:1",
    });

    const persisted = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
    assert.equal(persisted.performance[0].opened_by_cycle_id, "screening-123");
    assert.equal(persisted.performance[0].closed_by_action_id, "management-456:close_position:1");

    const summary = getPerformanceSummary();
    assert.equal(summary.total_positions_closed, 1);
    assert.equal(summary.total_inventory_pnl_usd, 10);
    assert.equal(summary.total_fee_component_usd, 12);
    assert.equal(summary.avg_operational_touch_count, 3);

    const proof = getStrategyProofSummary({ hours: 24 });
    assert.equal(proof.positions_analyzed, 1);
    assert.equal(proof.total_inventory_pnl_usd, 10);
    assert.equal(proof.total_fee_component_usd, 12);
    assert.equal(proof.strategy_breakdown[0].strategy, "bid_ask");
  } finally {
    process.chdir(originalCwd);
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    if (originalRolloutFile) process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = originalRolloutFile;
    else delete process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evolveThresholds writes current screening keys only", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-evolve-test-"));
  const originalUserConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
  const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;
  const originalRolloutFile = process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");
  const rolloutPath = path.join(tempDir, "threshold-rollout.json");

  try {
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = rolloutPath;
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

    const rollout = JSON.parse(fs.readFileSync(rolloutPath, "utf8"));
    assert.equal(rollout.active.changed_keys.includes("minFeeActiveTvlRatio"), true);
    assert.equal(rollout.active.changed_keys.includes("minOrganic"), true);
  } finally {
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    if (originalRolloutFile) process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = originalRolloutFile;
    else delete process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evolveThresholds rolls back pending rollout on degraded post-change performance", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-rollout-rollback-test-"));
  const originalUserConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
  const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;
  const originalRolloutFile = process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");
  const rolloutPath = path.join(tempDir, "threshold-rollout.json");

  try {
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = rolloutPath;
    fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.05, minOrganic: 60 }, null, 2));
    fs.writeFileSync(lessonsPath, JSON.stringify({ lessons: [], performance: [] }, null, 2));

    const { config } = await import(`./config.js?test=${Date.now()}`);
    const { evolveThresholds } = await import(`./lessons.js?test=${Date.now()}`);

    const baselinePerf = [
      { pnl_pct: 8, fee_tvl_ratio: 0.30, organic_score: 84 },
      { pnl_pct: 5, fee_tvl_ratio: 0.28, organic_score: 82 },
      { pnl_pct: -8, fee_tvl_ratio: 0.03, organic_score: 58 },
      { pnl_pct: -6, fee_tvl_ratio: 0.04, organic_score: 55 },
      { pnl_pct: -1, fee_tvl_ratio: 0.05, organic_score: 57 },
    ];
    const started = evolveThresholds(baselinePerf, config);
    assert.equal(started.rollout.status, "started");

    const postChangePerf = baselinePerf.concat([
      { pnl_pct: -12, fee_tvl_ratio: 0.15, organic_score: 65 },
      { pnl_pct: -10, fee_tvl_ratio: 0.16, organic_score: 66 },
      { pnl_pct: -9, fee_tvl_ratio: 0.12, organic_score: 64 },
      { pnl_pct: -11, fee_tvl_ratio: 0.14, organic_score: 63 },
      { pnl_pct: -8, fee_tvl_ratio: 0.18, organic_score: 62 },
    ]);

    const decision = evolveThresholds(postChangePerf, config);
    assert.equal(decision.rollout.status, "rolled_back");

    const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    assert.equal(persisted.minFeeActiveTvlRatio, 0.05);
    assert.equal(persisted.minOrganic, 60);
  } finally {
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    if (originalRolloutFile) process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = originalRolloutFile;
    else delete process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evolveThresholds accepts rollout when post-change performance stays healthy", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-rollout-accept-test-"));
  const originalUserConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
  const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;
  const originalRolloutFile = process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
  const userConfigPath = path.join(tempDir, "user-config.json");
  const lessonsPath = path.join(tempDir, "lessons.json");
  const rolloutPath = path.join(tempDir, "threshold-rollout.json");

  try {
    process.env.ZENITH_USER_CONFIG_PATH = userConfigPath;
    process.env.ZENITH_LESSONS_FILE = lessonsPath;
    process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = rolloutPath;
    fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.05, minOrganic: 60 }, null, 2));
    fs.writeFileSync(lessonsPath, JSON.stringify({ lessons: [], performance: [] }, null, 2));

    const { config } = await import(`./config.js?test=${Date.now()}`);
    const { evolveThresholds, getThresholdRolloutState } = await import(`./lessons.js?test=${Date.now()}`);

    const baselinePerf = [
      { pnl_pct: 8, fee_tvl_ratio: 0.30, organic_score: 84 },
      { pnl_pct: 5, fee_tvl_ratio: 0.28, organic_score: 82 },
      { pnl_pct: -8, fee_tvl_ratio: 0.03, organic_score: 58 },
      { pnl_pct: -6, fee_tvl_ratio: 0.04, organic_score: 55 },
      { pnl_pct: -1, fee_tvl_ratio: 0.05, organic_score: 57 },
    ];
    const started = evolveThresholds(baselinePerf, config);
    assert.equal(started.rollout.status, "started");

    const postChangePerf = baselinePerf.concat([
      { pnl_pct: 6, fee_tvl_ratio: 0.24, organic_score: 80 },
      { pnl_pct: 5, fee_tvl_ratio: 0.22, organic_score: 79 },
      { pnl_pct: 4, fee_tvl_ratio: 0.21, organic_score: 78 },
      { pnl_pct: 3, fee_tvl_ratio: 0.2, organic_score: 77 },
      { pnl_pct: 5, fee_tvl_ratio: 0.23, organic_score: 81 },
    ]);

    const decision = evolveThresholds(postChangePerf, config);
    assert.equal(decision.rollout.status, "accepted");
    assert.equal(getThresholdRolloutState().active, null);

    const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    assert.ok(persisted.minFeeActiveTvlRatio > 0.05);
    assert.ok(persisted.minOrganic > 60);
  } finally {
    if (originalUserConfigPath) process.env.ZENITH_USER_CONFIG_PATH = originalUserConfigPath;
    else delete process.env.ZENITH_USER_CONFIG_PATH;
    if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
    else delete process.env.ZENITH_LESSONS_FILE;
    if (originalRolloutFile) process.env.ZENITH_THRESHOLD_ROLLOUT_FILE = originalRolloutFile;
    else delete process.env.ZENITH_THRESHOLD_ROLLOUT_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
