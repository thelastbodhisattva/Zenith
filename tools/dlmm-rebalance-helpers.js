function toFiniteNumber(value, fallback = 0) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function toNullableFiniteNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function roundMetric(value, decimals = 4) {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function roundAmount(value, decimals = 6) {
	const sanitized = Math.max(0, toFiniteNumber(value, 0));
	const factor = 10 ** decimals;
	return Math.floor(sanitized * factor) / factor;
}

export function resolveExpectedVolumeProfile(feeTvlRatio) {
	const ratio = Math.max(0, toFiniteNumber(feeTvlRatio, 0));
	if (ratio >= 0.08) return "high";
	if (ratio >= 0.03) return "balanced";
	if (ratio <= 0.01) return "low";
	return "balanced";
}

export function inferTrendBiasFromBins(lowerBin, upperBin, activeBin) {
	if (!Number.isFinite(lowerBin) || !Number.isFinite(upperBin) || !Number.isFinite(activeBin)) {
		return "neutral";
	}
	if (activeBin > upperBin) return "bullish";
	if (activeBin < lowerBin) return "bearish";

	const span = upperBin - lowerBin;
	if (span <= 0) return "neutral";
	const ratio = (activeBin - lowerBin) / span;
	if (ratio >= 0.6) return "bullish";
	if (ratio <= 0.4) return "bearish";
	return "neutral";
}

export function getOutOfRangeDirection(lowerBin, upperBin, activeBin) {
	if (!Number.isFinite(lowerBin) || !Number.isFinite(upperBin) || !Number.isFinite(activeBin)) {
		return null;
	}
	if (activeBin > upperBin) return "above";
	if (activeBin < lowerBin) return "below";
	return null;
}

export function classifyRangeLocation({ lowerBin, upperBin, activeBin }) {
	if (!Number.isFinite(lowerBin) || !Number.isFinite(upperBin) || !Number.isFinite(activeBin)) {
		return {
			location: "unknown",
			in_range: null,
			normalized_position: null,
			distance_to_lower_bins: null,
			distance_to_upper_bins: null,
		};
	}

	if (upperBin <= lowerBin) {
		return {
			location: "unknown",
			in_range: null,
			normalized_position: null,
			distance_to_lower_bins: null,
			distance_to_upper_bins: null,
		};
	}

	if (activeBin < lowerBin) {
		return {
			location: "out_below",
			in_range: false,
			normalized_position: roundMetric((activeBin - lowerBin) / (upperBin - lowerBin), 4),
			distance_to_lower_bins: activeBin - lowerBin,
			distance_to_upper_bins: upperBin - activeBin,
		};
	}

	if (activeBin > upperBin) {
		return {
			location: "out_above",
			in_range: false,
			normalized_position: roundMetric((activeBin - lowerBin) / (upperBin - lowerBin), 4),
			distance_to_lower_bins: activeBin - lowerBin,
			distance_to_upper_bins: upperBin - activeBin,
		};
	}

	const span = upperBin - lowerBin;
	const ratio = (activeBin - lowerBin) / span;
	const location = ratio <= 0.33 ? "near_lower" : ratio >= 0.67 ? "near_upper" : "near_center";

	return {
		location,
		in_range: true,
		normalized_position: roundMetric(ratio, 4),
		distance_to_lower_bins: activeBin - lowerBin,
		distance_to_upper_bins: upperBin - activeBin,
	};
}

export function calculateBalanceDeltas(beforeSnapshot, afterSnapshot) {
	if (!beforeSnapshot || !afterSnapshot) {
		return { error: "Cannot compute balance deltas without before/after snapshots" };
	}

	const deltaXRaw = toNullableFiniteNumber(afterSnapshot.amount_x - beforeSnapshot.amount_x);
	const deltaYRaw = toNullableFiniteNumber(afterSnapshot.amount_y - beforeSnapshot.amount_y);

	if (deltaXRaw == null || deltaYRaw == null) {
		return { error: "Computed non-finite balance deltas" };
	}

	const amountX = roundAmount(Math.max(0, deltaXRaw), 6);
	const amountY = roundAmount(Math.max(0, deltaYRaw), 6);

	if (amountX <= 0 && amountY <= 0) {
		return {
			error: "No positive recovered token deltas detected after close",
			delta_x_raw: roundMetric(deltaXRaw, 8),
			delta_y_raw: roundMetric(deltaYRaw, 8),
		};
	}

	return {
		amount_x: amountX,
		amount_y: amountY,
		delta_x_raw: roundMetric(deltaXRaw, 8),
		delta_y_raw: roundMetric(deltaYRaw, 8),
	};
}

export function resolveBinSnapshot(position, pnl) {
	const lowerBin = toNullableFiniteNumber(pnl?.lower_bin) ?? toNullableFiniteNumber(position?.lower_bin);
	const upperBin = toNullableFiniteNumber(pnl?.upper_bin) ?? toNullableFiniteNumber(position?.upper_bin);
	const activeBin = toNullableFiniteNumber(pnl?.active_bin) ?? toNullableFiniteNumber(position?.active_bin);
	const inRange = typeof pnl?.in_range === "boolean"
		? pnl.in_range
		: typeof position?.in_range === "boolean"
			? position.in_range
			: null;

	return { lowerBin, upperBin, activeBin, inRange };
}

export function buildPoolPlanningData(position, binSnapshot) {
	const observedWidth = Number.isFinite(binSnapshot.lowerBin) && Number.isFinite(binSnapshot.upperBin)
		? Math.max(2, Math.abs(binSnapshot.upperBin - binSnapshot.lowerBin) / 3)
		: 8;

	const sixHourVolatility = roundMetric(
		Math.max(0, toFiniteNumber(position?.volatility, observedWidth)),
		2,
	);
	const trendBias = inferTrendBiasFromBins(binSnapshot.lowerBin, binSnapshot.upperBin, binSnapshot.activeBin);
	const syntheticPriceChange = trendBias === "bullish" ? 12 : trendBias === "bearish" ? -12 : 0;
	const feeTvlRatio = Math.max(0, toFiniteNumber(position?.fee_tvl_ratio, 0));

	return {
		pool_data: {
			six_hour_volatility: sixHourVolatility,
			fee_tvl_ratio: feeTvlRatio,
			organic_score: Math.max(0, toFiniteNumber(position?.organic_score, 0)),
			bin_step: Math.max(0, toFiniteNumber(position?.bin_step, 0)),
			price_change_pct: syntheticPriceChange,
			active_tvl: Math.max(0, toFiniteNumber(position?.total_value_usd, 0)),
			volume_24h: Math.max(0, toFiniteNumber(position?.volume_24h, 0)),
		},
		trend_bias: trendBias,
		expected_volume_profile: resolveExpectedVolumeProfile(feeTvlRatio),
	};
}

export function resolveCompoundingBias(rangeLocation) {
	if (rangeLocation.location === "near_upper" || rangeLocation.location === "out_above") {
		return "quote_heavy";
	}
	if (rangeLocation.location === "near_lower" || rangeLocation.location === "out_below") {
		return "base_heavy";
	}
	return "balanced";
}

export function normalizeCompoundingLocation(rangeLocation) {
	if (rangeLocation.location === "near_upper" || rangeLocation.location === "out_above") {
		return "near_upper";
	}
	if (rangeLocation.location === "near_lower" || rangeLocation.location === "out_below") {
		return "near_lower";
	}
	return "near_center";
}
