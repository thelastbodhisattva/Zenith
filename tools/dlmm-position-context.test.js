import assert from "node:assert/strict";
import test from "node:test";

import {
	buildTrackedPositionFallback,
	getPositionExecutionContext,
	resolvePoolTokenMints,
} from "./dlmm-position-context.js";
import { classifyRangeLocation, resolveBinSnapshot } from "./dlmm-rebalance-helpers.js";

test("dlmm position context builds tracked fallback deterministically", () => {
	const fallback = buildTrackedPositionFallback("pos-1", {
		getTrackedPosition: () => ({
			position: "pos-1",
			pool: "pool-1",
			pool_name: "Pool One",
			strategy: "bid_ask",
			bin_step: 100,
			volatility: 8,
			fee_tvl_ratio: 0.03,
			organic_score: 70,
			bin_range: { min: 100, max: 130 },
			active_bin_at_deploy: 120,
			initial_value_usd: 42,
		}),
	});
	assert.equal(fallback.position, "pos-1");
	assert.equal(fallback.source, "state_fallback");
	assert.equal(fallback.total_value_usd, 42);
});

test("dlmm position context falls back in dry run when live positions are unavailable", async () => {
	const context = await getPositionExecutionContext("pos-1", {
		getMyPositions: async () => ({ error: "rpc unavailable", positions: [] }),
		getPositionPnl: async () => ({ pnl_pct: 1 }),
		buildTrackedFallback: () => ({
			position: "pos-1",
			pool: "pool-1",
			pool_name: "Pool One",
			strategy: "bid_ask",
			lower_bin: 100,
			upper_bin: 130,
			active_bin: 120,
			in_range: true,
		}),
		resolveBinSnapshot,
		classifyRangeLocation,
		isDryRun: true,
	});
	assert.equal(context.context_source, "state_fallback");
	assert.equal(context.range_location.location, "near_upper");
});

test("dlmm position context resolves pool token mints through injected pool getter", async () => {
	const mints = await resolvePoolTokenMints({
		poolAddress: "pool-1",
		getPool: async () => ({
			lbPair: {
				tokenXMint: { toString: () => "mint-x" },
				tokenYMint: { toString: () => "mint-y" },
			},
		}),
	});
	assert.equal(mints.token_x_mint, "mint-x");
	assert.equal(mints.token_y_mint, "mint-y");
});
