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

test("memory context excludes non-approved nuggets", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-memory-allowed-nuggets-test-"));
	const originalDir = process.env.ZENITH_MEMORY_DIR;

	try {
		process.env.ZENITH_MEMORY_DIR = tempDir;
		const {
			getMemoryContext,
			initMemory,
			recallForScreening,
			rememberFact,
			rememberStrategy,
			rememberWalletScores,
		} = await import(`./memory.js?test=${Date.now()}`);
		initMemory();
		rememberStrategy({ strategy: "bid_ask", bin_step: 85 }, "worked well in tight bins");
		rememberFact("facts", "raw_fact", "should stay out of prompts");
		rememberWalletScores({
			pool_address: "pool-1",
			scored_wallets: [{ owner: "wallet-1", short_owner: "wallet-1", score_breakdown: { total_score: 10, base_score: 10 }, metrics: {} }],
		});

		const context = getMemoryContext();
		assert.ok(context.includes("strategy-bidask-tight"));
		assert.ok(!context.includes("raw_fact"));
		assert.ok(!context.includes("wallet-score-pool-1"));
		const before = fs.readFileSync(path.join(tempDir, "strategies.json"), "utf8");
		recallForScreening({ bin_step: 84 });
		const after = fs.readFileSync(path.join(tempDir, "strategies.json"), "utf8");
		assert.equal(after, before);
	} finally {
		if (originalDir) process.env.ZENITH_MEMORY_DIR = originalDir;
		else delete process.env.ZENITH_MEMORY_DIR;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("memory context is role-aware for prompt-conditioned nuggets", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-memory-role-aware-test-"));
	const originalDir = process.env.ZENITH_MEMORY_DIR;

	try {
		process.env.ZENITH_MEMORY_DIR = tempDir;
		const { getMemoryContext, initMemory, rememberStrategy, rememberTokenTypeDistribution } = await import(`./memory.js?test=${Date.now()}`);
		initMemory();
		rememberStrategy({ strategy: "bid_ask", bin_step: 85, role: "MANAGER" }, "manager strategy memory");
		rememberTokenTypeDistribution({ distribution_key: "quote_heavy", strategy: "bid_ask", success: true, role: "MANAGER" });

		const managerContext = getMemoryContext("MANAGER");
		const screenerContext = getMemoryContext("SCREENER");
		assert.ok(managerContext.includes("strategy-bidask-tight"));
		assert.ok(!screenerContext?.includes("strategy-bidask-tight"));
		assert.ok(!screenerContext?.includes("distribution-quoteheavy"));
	} finally {
		if (originalDir) process.env.ZENITH_MEMORY_DIR = originalDir;
		else delete process.env.ZENITH_MEMORY_DIR;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("recallForScreening and recallForManagement respect role-tagged strategy memory", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-memory-role-recall-test-"));
	const originalDir = process.env.ZENITH_MEMORY_DIR;

	try {
		process.env.ZENITH_MEMORY_DIR = tempDir;
		const {
			initMemory,
			recallForManagement,
			recallForScreening,
			rememberStrategy,
		} = await import(`./memory.js?test=${Date.now()}`);
		initMemory();
		rememberStrategy({ strategy: "bid_ask", bin_step: 85, role: "MANAGER" }, "manager strategy memory");
		rememberStrategy({ strategy: "bid_ask", bin_step: 85, role: "SCREENER" }, "screener strategy memory");

		const screenerHits = recallForScreening({ bin_step: 84 });
		assert.equal(screenerHits.length, 1);
		assert.equal(screenerHits[0].answer, "screener strategy memory");

		const managerHits = recallForManagement({ strategy: "bid_ask", bin_step: 84 });
		assert.equal(managerHits[0].answer, "manager strategy memory");
	} finally {
		if (originalDir) process.env.ZENITH_MEMORY_DIR = originalDir;
		else delete process.env.ZENITH_MEMORY_DIR;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
