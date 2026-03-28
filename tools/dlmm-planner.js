const MAX_BINS_PER_SIDE = 34;
const MIN_BINS_PER_SIDE = 6;

function toFiniteNumber(value, fallback = 0) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function clampNumber(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function clampWholeNumber(value, min, max) {
	return Math.round(clampNumber(toFiniteNumber(value, min), min, max));
}

function roundMetric(value, decimals = 4) {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

function normalizeExpectedVolumeProfile(profile) {
	const normalized = String(profile || "balanced").trim().toLowerCase();
	const profileMap = {
		low: "low",
		light: "low",
		thin: "low",
		balanced: "balanced",
		moderate: "balanced",
		normal: "balanced",
		medium: "balanced",
		high: "high",
		heavy: "high",
		strong: "high",
		bursty: "bursty",
		spiky: "bursty",
		surge: "bursty",
		surging: "bursty",
	};
	return profileMap[normalized] || "balanced";
}

function normalizeTrendBias(trendBias) {
	if (typeof trendBias === "number") {
		const value = clampNumber(trendBias, -1, 1);
		return {
			label: value >= 0.25 ? "bullish" : value <= -0.25 ? "bearish" : "neutral",
			value,
		};
	}

	const normalized = String(trendBias || "neutral").trim().toLowerCase();
	const trendMap = {
		bullish: 0.75,
		bull: 0.75,
		up: 0.75,
		uptrend: 0.75,
		bearish: -0.75,
		bear: -0.75,
		down: -0.75,
		downtrend: -0.75,
		neutral: 0,
		flat: 0,
		sideways: 0,
		range: 0,
	};
	const value = trendMap[normalized] ?? 0;
	return {
		label: value >= 0.25 ? "bullish" : value <= -0.25 ? "bearish" : "neutral",
		value,
	};
}

function normalizeWeights(weights) {
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) {
		return weights.map(() => roundMetric(1 / weights.length));
	}
	return weights.map((weight) => roundMetric(weight / total));
}

function splitIntegerByWeights(total, weights) {
	if (total <= 0) return weights.map(() => 0);

	const normalizedWeights = normalizeWeights(weights);
	const positiveIndexes = normalizedWeights
		.map((weight, index) => (weight > 0 ? index : -1))
		.filter((index) => index >= 0);
	const guaranteed = total >= positiveIndexes.length ? 1 : 0;
	const segments = normalizedWeights.map((weight) => (weight > 0 ? guaranteed : 0));
	let remaining = total - segments.reduce((sum, segment) => sum + segment, 0);

	if (remaining <= 0) {
		return segments;
	}

	const rawAllocations = normalizedWeights.map((weight, index) => ({
		index,
		raw: weight * remaining,
	}));

	for (const allocation of rawAllocations) {
		const whole = Math.floor(allocation.raw);
		segments[allocation.index] += whole;
		remaining -= whole;
		allocation.fraction = allocation.raw - whole;
	}

	rawAllocations
		.sort((a, b) => (b.fraction || 0) - (a.fraction || 0))
		.slice(0, remaining)
		.forEach(({ index }) => {
			segments[index] += 1;
		});

	return segments;
}

function resolveSideBinTarget(sixHourVolatility) {
	const volatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
	if (volatility <= 2) return 10;
	if (volatility <= 4) return 12;
	if (volatility <= 8) return 16;
	if (volatility <= 12) return 20;
	if (volatility <= 18) return 24;
	if (volatility <= 25) return 30;
	return MAX_BINS_PER_SIDE;
}

function resolveTierSplitWeights(sixHourVolatility) {
	const volatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
	if (volatility <= 6) return { outer: 0.2, inner: 0.25, center: 0.55 };
	if (volatility <= 12) return { outer: 0.22, inner: 0.28, center: 0.5 };
	if (volatility <= 18) return { outer: 0.24, inner: 0.3, center: 0.46 };
	if (volatility <= 25) return { outer: 0.26, inner: 0.31, center: 0.43 };
	return { outer: 0.28, inner: 0.32, center: 0.4 };
}

function normalizePoolPlanningInputs(poolData = {}) {
	return {
		volatility: Math.max(
			0,
			toFiniteNumber(poolData.six_hour_volatility ?? poolData.volatility_6h ?? poolData.volatility, 0),
		),
		feeTvlRatio: Math.max(0, toFiniteNumber(poolData.fee_tvl_ratio ?? poolData.feeActiveTvlRatio, 0)),
		organicScore: Math.max(0, toFiniteNumber(poolData.organic_score ?? poolData.organic, 0)),
		binStep: Math.max(0, toFiniteNumber(poolData.bin_step, 0)),
		priceChangePct: toFiniteNumber(
			poolData.price_change_pct ?? poolData.priceChangePct ?? poolData.price_change_24h,
			0,
		),
		activeTvl: Math.max(0, toFiniteNumber(poolData.active_tvl ?? poolData.tvl ?? poolData.liquidity, 0)),
		volume24h: Math.max(0, toFiniteNumber(poolData.volume_24h ?? poolData.trade_volume_24h, 0)),
	};
}

function buildDistributionWeights(strategy, volumeProfile, priceChangePct) {
	const inferredTrend = normalizeTrendBias(clampNumber(priceChangePct / 20, -1, 1));

	if (strategy === "bid_ask") {
		const lowerWeight =
			0.68 - Math.max(0, inferredTrend.value) * 0.08 + Math.max(0, -inferredTrend.value) * 0.06;
		const centerWeight =
			volumeProfile === "bursty" ? 0.36 : volumeProfile === "high" ? 0.34 : 0.32;
		const normalized = normalizeWeights([lowerWeight, centerWeight, 0]);
		return {
			lower: normalized[0],
			center: normalized[1],
			upper: normalized[2],
			tokenBias: "quote_heavy",
			activeBinTreatment: "defensive",
			inferredTrend,
		};
	}

	let lowerWeight = 0.24;
	const centerWeight = volumeProfile === "high" ? 0.56 : volumeProfile === "bursty" ? 0.48 : 0.52;
	let upperWeight = 0.24;

	if (inferredTrend.value > 0) {
		const shift = 0.08 * inferredTrend.value;
		lowerWeight -= shift;
		upperWeight += shift;
	} else if (inferredTrend.value < 0) {
		const shift = 0.08 * Math.abs(inferredTrend.value);
		lowerWeight += shift;
		upperWeight -= shift;
	}

	const normalized = normalizeWeights([lowerWeight, centerWeight, upperWeight]);
  return {
    lower: normalized[0],
    center: normalized[1],
    upper: normalized[2],
    tokenBias: "balanced",
    activeBinTreatment: volumeProfile === "bursty" ? "buffered" : "balanced",
    inferredTrend,
  };
}

function buildTierRange(side, startOffset, endOffset, binsBelow, binsAbove, includesActiveBin = false) {
	return {
		side,
		start_offset: startOffset,
		end_offset: endOffset,
		bins_below: clampWholeNumber(binsBelow, 0, MAX_BINS_PER_SIDE),
		bins_above: clampWholeNumber(binsAbove, 0, MAX_BINS_PER_SIDE),
		includes_active_bin: includesActiveBin,
	};
}

export function calculateDynamicBinTierPlan(sixHourVolatility, trendBias = "neutral") {
	const normalizedVolatility = Math.max(0, toFiniteNumber(sixHourVolatility, 0));
	const normalizedTrend = normalizeTrendBias(trendBias);
	const baseSideBins = resolveSideBinTarget(normalizedVolatility);
	const lowerMultiplier = normalizedTrend.value < 0
		? 1 + Math.abs(normalizedTrend.value) * 0.25
		: 1 - normalizedTrend.value * 0.15;
	const upperMultiplier = normalizedTrend.value > 0
		? 1 + normalizedTrend.value * 0.25
		: 1 - Math.abs(normalizedTrend.value) * 0.15;

	const lowerTotal = clampWholeNumber(baseSideBins * lowerMultiplier, MIN_BINS_PER_SIDE, MAX_BINS_PER_SIDE);
	const upperTotal = clampWholeNumber(baseSideBins * upperMultiplier, MIN_BINS_PER_SIDE, MAX_BINS_PER_SIDE);
	const splitWeights = resolveTierSplitWeights(normalizedVolatility);

	const [lowerOuterBins, lowerInnerBins, centerLowerBins] = splitIntegerByWeights(lowerTotal, [
		splitWeights.outer,
		splitWeights.inner,
		splitWeights.center,
	]);
	const [centerUpperBins, upperInnerBins, upperOuterBins] = splitIntegerByWeights(upperTotal, [
		splitWeights.center,
		splitWeights.inner,
		splitWeights.outer,
	]);

	const lowerSideAllocation = 0.34 - normalizedTrend.value * 0.1;
	const upperSideAllocation = 0.34 + normalizedTrend.value * 0.1;
	const [lowerOuterWeight, lowerInnerWeight, centerWeight, upperInnerWeight, upperOuterWeight] = normalizeWeights([
		lowerSideAllocation * 0.35,
		lowerSideAllocation * 0.65,
		0.32,
		upperSideAllocation * 0.65,
		upperSideAllocation * 0.35,
	]);

	const centerStart = centerLowerBins > 0 ? -centerLowerBins : 0;
	const centerEnd = centerUpperBins > 0 ? centerUpperBins : 0;
	const lowerInnerStart = -(centerLowerBins + lowerInnerBins);
	const lowerInnerEnd = -(centerLowerBins + 1);
	const lowerOuterEnd = -(centerLowerBins + lowerInnerBins + 1);
	const upperInnerStart = centerUpperBins + 1;
	const upperInnerEnd = centerUpperBins + upperInnerBins;
	const upperOuterStart = centerUpperBins + upperInnerBins + 1;

	const tiers = [
		{
			id: "lower_outer",
			label: "Lower Outer",
			allocation_weight: lowerOuterWeight,
			...buildTierRange("lower", -lowerTotal, lowerOuterEnd, lowerOuterBins, 0),
		},
		{
			id: "lower_inner",
			label: "Lower Inner",
			allocation_weight: lowerInnerWeight,
			...buildTierRange("lower", lowerInnerStart, lowerInnerEnd, lowerInnerBins, 0),
		},
		{
			id: "center",
			label: "Center",
			allocation_weight: centerWeight,
			...buildTierRange("center", centerStart, centerEnd, centerLowerBins, centerUpperBins, true),
		},
		{
			id: "upper_inner",
			label: "Upper Inner",
			allocation_weight: upperInnerWeight,
			...buildTierRange("upper", upperInnerStart, upperInnerEnd, 0, upperInnerBins),
		},
		{
			id: "upper_outer",
			label: "Upper Outer",
			allocation_weight: upperOuterWeight,
			...buildTierRange("upper", upperOuterStart, upperTotal, 0, upperOuterBins),
		},
	];

	return {
		six_hour_volatility: roundMetric(normalizedVolatility, 2),
		trend_bias: normalizedTrend.label,
		trend_bias_score: roundMetric(normalizedTrend.value, 2),
		max_bins_per_side: MAX_BINS_PER_SIDE,
		range_plan: {
			bins_below: lowerTotal,
			bins_above: upperTotal,
			total_bins: lowerTotal + upperTotal,
			center_bin_included: true,
			hard_clamped: lowerTotal === MAX_BINS_PER_SIDE || upperTotal === MAX_BINS_PER_SIDE,
		},
		distribution_weights: {
			lower: roundMetric(lowerOuterWeight + lowerInnerWeight),
			center: centerWeight,
			upper: roundMetric(upperInnerWeight + upperOuterWeight),
		},
		tiers,
	};
}

export function chooseDistributionStrategyPlan({ pool_data = {}, expected_volume_profile = "balanced" }) {
	const poolData = normalizePoolPlanningInputs(pool_data);
	const volumeProfile = normalizeExpectedVolumeProfile(expected_volume_profile);

	let spotScore = 0;
	let bidAskScore = 0;

	if (volumeProfile === "high") spotScore += 2;
	if (volumeProfile === "balanced") {
		spotScore += 1;
		bidAskScore += 1;
	}
	if (volumeProfile === "low") bidAskScore += 2;
	if (volumeProfile === "bursty") bidAskScore += 2;

	if (poolData.volatility >= 18) bidAskScore += 2;
	else if (poolData.volatility >= 10) {
		bidAskScore += 1;
		spotScore += 1;
	} else {
		spotScore += 2;
	}

	if (Math.abs(poolData.priceChangePct) >= 15) bidAskScore += 2;
	else if (Math.abs(poolData.priceChangePct) >= 8) bidAskScore += 1;
	else spotScore += 1;

	if (poolData.feeTvlRatio >= 0.08) spotScore += 2;
	else if (poolData.feeTvlRatio >= 0.04) {
		spotScore += 1;
		bidAskScore += 1;
	} else {
		bidAskScore += 1;
	}

	if (poolData.binStep >= 110) bidAskScore += 1;
	else if (poolData.binStep > 0 && poolData.binStep <= 90) spotScore += 1;

	if (poolData.organicScore >= 80) spotScore += 1;
	else if (poolData.organicScore > 0 && poolData.organicScore < 65) bidAskScore += 1;

	if (poolData.activeTvl >= 100000) spotScore += 1;
	else if (poolData.activeTvl > 0 && poolData.activeTvl < 25000) bidAskScore += 1;

	const strategy = spotScore > bidAskScore
		? "spot"
		: bidAskScore > spotScore
			? "bid_ask"
			: volumeProfile === "high" || volumeProfile === "balanced"
				? "spot"
				: "bid_ask";

	const distribution = buildDistributionWeights(strategy, volumeProfile, poolData.priceChangePct);

	return {
		strategy,
		expected_volume_profile: volumeProfile,
		strategy_scores: {
			bid_ask: bidAskScore,
			spot: spotScore,
		},
		distribution_plan: {
			lower_allocation: distribution.lower,
			center_allocation: distribution.center,
			upper_allocation: distribution.upper,
			lower_enabled: true,
			center_enabled: true,
			upper_enabled: strategy === "spot",
			token_bias: distribution.tokenBias,
			active_bin_treatment: distribution.activeBinTreatment,
		},
		pool_snapshot: {
			volatility: roundMetric(poolData.volatility, 2),
			fee_tvl_ratio: roundMetric(poolData.feeTvlRatio, 4),
			organic_score: roundMetric(poolData.organicScore, 2),
			bin_step: poolData.binStep,
			price_change_pct: roundMetric(poolData.priceChangePct, 2),
			active_tvl: roundMetric(poolData.activeTvl, 2),
			volume_24h: roundMetric(poolData.volume24h, 2),
		},
		next_step_inputs: {
			six_hour_volatility: roundMetric(poolData.volatility, 2),
			trend_bias: distribution.inferredTrend.label,
			max_bins_per_side: MAX_BINS_PER_SIDE,
		},
		supported_strategies: ["bid_ask", "spot"],
	};
}
