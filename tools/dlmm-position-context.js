function toNullableFiniteNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function findTokenBalanceByMint(walletBalances, mint, normalizeMint) {
	if (!mint || !walletBalances || !Array.isArray(walletBalances.tokens)) return null;
	const normalizedMint = normalizeMint(mint);
	return walletBalances.tokens.find((token) => normalizeMint(token.mint) === normalizedMint) || null;
}

function getWalletBalanceByMint(walletBalances, mint, { normalizeMint, solMint }) {
	const normalizedMint = normalizeMint(mint);
	if (normalizedMint === solMint) {
		return toNullableFiniteNumber(walletBalances?.sol);
	}

	const token = findTokenBalanceByMint(walletBalances, normalizedMint, normalizeMint);
	if (!token) return 0;
	return toNullableFiniteNumber(token.balance);
}

export async function captureBalanceSnapshotForMints({
	token_x_mint,
	token_y_mint,
	phase,
	getWalletBalances,
	normalizeMint,
	solMint,
}) {
	const balances = await getWalletBalances();
	if (balances?.error) {
		return {
			error: `Unable to load wallet balances ${phase}: ${balances.error}`,
		};
	}

	const tokenXAmount = getWalletBalanceByMint(balances, token_x_mint, {
		normalizeMint,
		solMint,
	});
	const tokenYAmount = getWalletBalanceByMint(balances, token_y_mint, {
		normalizeMint,
		solMint,
	});

	if (tokenXAmount == null || tokenYAmount == null) {
		return {
			error: `Unable to read token balances ${phase} for pool token mints`,
		};
	}

	return {
		token_x_mint: normalizeMint(token_x_mint),
		token_y_mint: normalizeMint(token_y_mint),
		amount_x: tokenXAmount,
		amount_y: tokenYAmount,
		sampled_at: new Date().toISOString(),
	};
}

export async function resolvePoolTokenMints({ poolAddress, getPool }) {
	if (!poolAddress) return null;
	try {
		const pool = await getPool(poolAddress);
		return {
			token_x_mint: pool?.lbPair?.tokenXMint?.toString() || null,
			token_y_mint: pool?.lbPair?.tokenYMint?.toString() || null,
		};
	} catch (error) {
		return { error: error.message };
	}
}

export function buildTrackedPositionFallback(position_address, { getTrackedPosition }) {
	const tracked = getTrackedPosition(position_address);
	if (!tracked || tracked.closed) return null;

	return {
		position: tracked.position,
		pool: tracked.pool,
		pair: tracked.pool_name || tracked.pool?.slice(0, 8) || null,
		pool_name: tracked.pool_name || null,
		strategy: tracked.strategy || null,
		bin_step: tracked.bin_step ?? null,
		volatility: tracked.volatility ?? null,
		fee_tvl_ratio: tracked.fee_tvl_ratio ?? null,
		organic_score: tracked.organic_score ?? null,
		lower_bin: tracked.bin_range?.min ?? null,
		upper_bin: tracked.bin_range?.max ?? null,
		active_bin: tracked.active_bin_at_deploy ?? null,
		in_range: tracked.out_of_range_since ? false : true,
		unclaimed_fees_usd: 0,
		total_value_usd: tracked.initial_value_usd ?? 0,
		source: "state_fallback",
	};
}

export async function getPositionExecutionContext(position_address, {
	getMyPositions,
	getPositionPnl,
	buildTrackedFallback,
	resolveBinSnapshot,
	classifyRangeLocation,
	isDryRun,
}) {
	const positionsResult = await getMyPositions({ force: true });
	if (positionsResult?.error) {
		if (isDryRun) {
			const fallbackPosition = buildTrackedFallback(position_address);
			if (fallbackPosition) {
				const binSnapshot = resolveBinSnapshot(fallbackPosition, null);
				const rangeLocation = classifyRangeLocation(binSnapshot);
				return {
					position: fallbackPosition,
					pnl: null,
					bin_snapshot: binSnapshot,
					range_location: rangeLocation,
					in_range: binSnapshot.inRange,
					context_source: "state_fallback",
				};
			}
		}
		return {
			error: `Unable to load open positions: ${positionsResult.error}`,
			positions: positionsResult.positions || [],
		};
	}

	const position = (positionsResult.positions || []).find((item) => item.position === position_address);
	if (!position) {
		if (isDryRun) {
			const fallbackPosition = buildTrackedFallback(position_address);
			if (fallbackPosition) {
				const binSnapshot = resolveBinSnapshot(fallbackPosition, null);
				const rangeLocation = classifyRangeLocation(binSnapshot);
				return {
					position: fallbackPosition,
					pnl: null,
					bin_snapshot: binSnapshot,
					range_location: rangeLocation,
					in_range: binSnapshot.inRange,
					context_source: "state_fallback",
				};
			}
		}
		return {
			error: `Position ${position_address} was not found in open positions`,
			positions: positionsResult.positions || [],
		};
	}

	let pnl = null;
	try {
		pnl = await getPositionPnl({ pool_address: position.pool, position_address });
	} catch (error) {
		pnl = { error: error.message };
	}

	const binSnapshot = resolveBinSnapshot(position, pnl);
	const rangeLocation = classifyRangeLocation(binSnapshot);

	return {
		position,
		pnl,
		bin_snapshot: binSnapshot,
		range_location: rangeLocation,
		in_range: binSnapshot.inRange,
	};
}
