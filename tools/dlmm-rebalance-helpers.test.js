import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPoolPlanningData,
	calculateBalanceDeltas,
	classifyRangeLocation,
	normalizeCompoundingLocation,
	resolveCompoundingBias,
	resolveExpectedVolumeProfile,
} from "./dlmm-rebalance-helpers.js";

test("dlmm rebalance helpers classify range location deterministically", () => {
	const nearUpper = classifyRangeLocation({ lowerBin: 100, upperBin: 130, activeBin: 125 });
	assert.equal(nearUpper.location, "near_upper");
	assert.equal(resolveCompoundingBias(nearUpper), "quote_heavy");
	assert.equal(normalizeCompoundingLocation(nearUpper), "near_upper");

	const outBelow = classifyRangeLocation({ lowerBin: 100, upperBin: 130, activeBin: 90 });
	assert.equal(outBelow.location, "out_below");
	assert.equal(resolveCompoundingBias(outBelow), "base_heavy");
});

test("dlmm rebalance helpers derive bounded planning data and recovered deltas", () => {
	const planning = buildPoolPlanningData(
		{ volatility: 14, fee_tvl_ratio: 0.04, organic_score: 72, bin_step: 100, total_value_usd: 2500, volume_24h: 15000 },
		{ lowerBin: 100, upperBin: 130, activeBin: 120 },
	);
	assert.equal(planning.trend_bias, "bullish");
	assert.equal(planning.expected_volume_profile, resolveExpectedVolumeProfile(0.04));

	const deltas = calculateBalanceDeltas(
		{ amount_x: 2, amount_y: 1 },
		{ amount_x: 2.75, amount_y: 1.35 },
	);
	assert.equal(deltas.amount_x > 0, true);
	assert.equal(deltas.amount_y > 0, true);
	assert.equal(deltas.error, undefined);
});
