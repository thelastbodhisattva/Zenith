import assert from "node:assert/strict";
import test from "node:test";

import { calculateDynamicBinTierPlan, chooseDistributionStrategyPlan } from "./dlmm-planner.js";

test("dlmm planner chooses deterministic strategy and distribution from pool inputs", () => {
	const plan = chooseDistributionStrategyPlan({
		pool_data: {
			six_hour_volatility: 14,
			fee_tvl_ratio: 0.03,
			organic_score: 70,
			bin_step: 120,
			price_change_pct: 12,
			active_tvl: 20000,
			volume_24h: 8000,
		},
		expected_volume_profile: "bursty",
	});

	assert.equal(plan.strategy, "bid_ask");
	assert.equal(plan.expected_volume_profile, "bursty");
	assert.equal(plan.supported_strategies.includes(plan.strategy), true);
	assert.equal(plan.distribution_plan.upper_enabled, false);
});

test("dlmm planner builds bounded tier plans with active center bin", () => {
	const plan = calculateDynamicBinTierPlan(18, "bullish");
	assert.equal(plan.max_bins_per_side, 34);
	assert.equal(plan.range_plan.center_bin_included, true);
	assert.equal(plan.tiers.length, 5);
	assert.equal(plan.range_plan.bins_above <= 34, true);
	assert.equal(plan.range_plan.bins_below <= 34, true);
});
