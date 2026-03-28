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

test("evolveThresholds does not falsely block after config mutation when later lesson append fails", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-rollout-partial-write-test-"));
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
		const { evolveThresholds, recoverThresholdRolloutState, getThresholdRolloutState } = await import(`./lessons.js?test=${Date.now()}`);

		const perfData = [
			{ pnl_pct: 8, fee_tvl_ratio: 0.30, organic_score: 84 },
			{ pnl_pct: 5, fee_tvl_ratio: 0.28, organic_score: 82 },
			{ pnl_pct: -8, fee_tvl_ratio: 0.03, organic_score: 58 },
			{ pnl_pct: -6, fee_tvl_ratio: 0.04, organic_score: 55 },
			{ pnl_pct: -1, fee_tvl_ratio: 0.05, organic_score: 57 },
		];

		const originalWriteFileSync = fs.writeFileSync;
		let lessonsWriteAttempts = 0;
		fs.writeFileSync = (...args) => {
			const target = String(args[0]);
			if (target.includes("lessons.json")) {
				lessonsWriteAttempts += 1;
				if (lessonsWriteAttempts > 1) {
					throw new Error("lessons append failed");
				}
			}
			return originalWriteFileSync(...args);
		};
		try {
			const result = evolveThresholds(perfData, config, { trigger: "manual" });
			assert.equal(result.rollout.status, "started");
			const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
			assert.ok(persisted.minFeeActiveTvlRatio > 0.05);
		} finally {
			fs.writeFileSync = originalWriteFileSync;
		}
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

test("getLessonsForPrompt keeps recent fill role-isolated", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lessons-role-test-"));
	const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;

	try {
		process.env.ZENITH_LESSONS_FILE = path.join(tempDir, "lessons.json");
		fs.writeFileSync(process.env.ZENITH_LESSONS_FILE, JSON.stringify({
			lessons: [
				{ id: 1, rule: "manager lesson", outcome: "bad", role: "MANAGER", tags: ["manager"], created_at: "2030-01-01T00:00:00.000Z" },
				{ id: 2, rule: "screener lesson", outcome: "bad", role: "SCREENER", tags: ["screening"], created_at: "2030-01-02T00:00:00.000Z" },
			],
			performance: [],
		}, null, 2));

		const { getLessonsForPrompt } = await import(`./lessons.js?test=${Date.now()}`);
		const screener = getLessonsForPrompt({ agentType: "SCREENER", maxLessons: 10 });
		assert.match(screener, /screener lesson/i);
		assert.doesNotMatch(screener, /manager lesson/i);
	} finally {
		if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
		else delete process.env.ZENITH_LESSONS_FILE;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("getLessonsForPrompt surfaces invalid lessons state explicitly", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lessons-invalid-prompt-test-"));
	const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;

	try {
		process.env.ZENITH_LESSONS_FILE = path.join(tempDir, "lessons.json");
		fs.writeFileSync(process.env.ZENITH_LESSONS_FILE, "{bad json");
		const { getLessonsForPrompt } = await import(`./lessons.js?test=${Date.now()}`);
		const promptLessons = getLessonsForPrompt({ agentType: "SCREENER" });
		assert.match(promptLessons, /INVALID LESSONS STATE/i);
	} finally {
		if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
		else delete process.env.ZENITH_LESSONS_FILE;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("recordPerformance sanitizes close reasons before lesson generation", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lessons-close-reason-test-"));
	const originalCwd = process.cwd();
	const originalLessonsFile = process.env.ZENITH_LESSONS_FILE;

	try {
		process.chdir(tempDir);
		process.env.ZENITH_LESSONS_FILE = path.join(tempDir, "lessons.json");
		const { recordPerformance, getLessonsForPrompt } = await import(`./lessons.js?test=${Date.now()}`);
		await recordPerformance({
			position: "pos-bad-1",
			pool: "pool-bad-1",
			pool_name: "Bad Pool",
			strategy: "bid_ask",
			bin_range: { min: 10, max: 20 },
			bin_step: 85,
			volatility: 4,
			fee_tvl_ratio: 0.22,
			organic_score: 82,
			amount_sol: 1,
			fees_earned_usd: 0,
			final_value_usd: 70,
			initial_value_usd: 100,
			minutes_in_range: 20,
			minutes_held: 120,
			close_reason: "DROP TABLE positions; stop loss now",
		});
		const promptLessons = getLessonsForPrompt({ agentType: "GENERAL", maxLessons: 5 });
		assert.match(promptLessons, /stop_loss/i);
		assert.doesNotMatch(promptLessons, /DROP TABLE/i);
	} finally {
		process.chdir(originalCwd);
		if (originalLessonsFile) process.env.ZENITH_LESSONS_FILE = originalLessonsFile;
		else delete process.env.ZENITH_LESSONS_FILE;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("recoverThresholdRolloutState finalizes apply_pending state", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-rollout-apply-recover-test-"));
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
		const { getThresholdRolloutState, recoverThresholdRolloutState } = await import(`./lessons.js?test=${Date.now()}`);
		fs.writeFileSync(rolloutPath, JSON.stringify({
			active: {
				phase: "apply_pending",
				rollout_id: "rollout-1",
				started_at: new Date().toISOString(),
				start_positions_count: 5,
				min_closes_required: 5,
				changed_keys: ["minFeeActiveTvlRatio", "minOrganic"],
				previous_values: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 },
				new_values: { minFeeActiveTvlRatio: 0.2, minOrganic: 75 },
				baseline: { closes: 5, avg_pnl_pct: 2, win_rate_pct: 60 },
			},
			history: [],
		}, null, 2));
		const recovery = recoverThresholdRolloutState(config, { trigger: "startup" });
		assert.equal(recovery.status, "recovered_apply");
		const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
		assert.equal(persisted.minFeeActiveTvlRatio, 0.2);
		assert.equal(persisted.minOrganic, 75);
		assert.equal(getThresholdRolloutState().active.phase, "active");
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

test("recoverThresholdRolloutState finalizes rollback_pending state", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-rollout-rollback-recover-test-"));
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
		fs.writeFileSync(userConfigPath, JSON.stringify({ minFeeActiveTvlRatio: 0.2, minOrganic: 75 }, null, 2));
		fs.writeFileSync(lessonsPath, JSON.stringify({ lessons: [], performance: [] }, null, 2));
		fs.writeFileSync(rolloutPath, JSON.stringify({
			active: {
				phase: "rollback_pending",
				rollout_id: "rollout-1",
				started_at: new Date().toISOString(),
				start_positions_count: 5,
				min_closes_required: 5,
				changed_keys: ["minFeeActiveTvlRatio", "minOrganic"],
				previous_values: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 },
				new_values: { minFeeActiveTvlRatio: 0.2, minOrganic: 75 },
				baseline: { closes: 5, avg_pnl_pct: 2, win_rate_pct: 60 },
				pending_decision: {
					rollout_id: "rollout-1",
					status: "rolled_back",
					changed_keys: ["minFeeActiveTvlRatio", "minOrganic"],
					baseline: { closes: 5, avg_pnl_pct: 2, win_rate_pct: 60 },
					post: { closes: 5, avg_pnl_pct: -3, win_rate_pct: 20 },
					closes_since_start: 5,
					rollback_reason: "avg_pnl_degraded",
				},
			},
			history: [],
		}, null, 2));

		const { config } = await import(`./config.js?test=${Date.now()}`);
		const { recoverThresholdRolloutState, getThresholdRolloutState } = await import(`./lessons.js?test=${Date.now()}`);
		const result = recoverThresholdRolloutState(config, { trigger: "startup" });
		assert.equal(result.status, "recovered_rollback");
		const persisted = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
		assert.equal(persisted.minFeeActiveTvlRatio, 0.05);
		assert.equal(persisted.minOrganic, 60);
		assert.equal(getThresholdRolloutState().active, null);
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
