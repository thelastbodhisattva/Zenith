import { PublicKey } from "@solana/web3.js";

export function buildClosePerformancePayload({
	tracked,
	cachedPosition,
	poolAddress,
	pool,
	positionAddress,
	minutesHeld,
	minutesOutOfRange,
	reason,
	decisionContext,
} = {}) {
	const pnlUsd = cachedPosition?.pnl_usd ?? 0;
	const pnlPct = cachedPosition?.pnl_pct ?? 0;
	const finalValueUsd = cachedPosition?.total_value_usd ?? 0;
	const feesUsd = cachedPosition
		? (cachedPosition.collected_fees_usd || 0) + (cachedPosition.unclaimed_fees_usd || 0)
		: tracked.total_fees_claimed_usd || 0;

	return {
		performance: {
			position: positionAddress,
			pool: poolAddress,
			pool_name: tracked.pool_name || poolAddress.slice(0, 8),
			strategy: tracked.strategy,
			bin_range: tracked.bin_range,
			bin_step: tracked.bin_step || null,
			volatility: tracked.volatility || null,
			fee_tvl_ratio: tracked.fee_tvl_ratio || null,
			organic_score: tracked.organic_score || null,
			amount_sol: tracked.amount_sol,
			base_mint: tracked.base_mint || pool.lbPair.tokenXMint.toString(),
			fees_earned_usd: feesUsd,
			final_value_usd: finalValueUsd,
			initial_value_usd: tracked.initial_value_usd || 0,
			minutes_in_range: Math.max(0, (minutesHeld || 0) - (minutesOutOfRange || 0)),
			minutes_held: minutesHeld || 0,
			claim_count: tracked.claim_count || 0,
			rebalance_count: tracked.rebalance_count || 0,
			close_reason: reason,
			regime_label: tracked.regime_label || null,
			opened_by_cycle_id: tracked.opened_by_cycle_id || null,
			opened_by_action_id: tracked.opened_by_action_id || null,
			opened_by_workflow_id: tracked.opened_by_workflow_id || null,
			closed_by_cycle_id: decisionContext?.cycle_id || null,
			closed_by_action_id: decisionContext?.action_id || null,
			closed_by_workflow_id: decisionContext?.workflow_id || null,
		},
		result: {
			pnl_usd: pnlUsd,
			pnl_pct: pnlPct,
		},
	};
}

export function computeObservedTokenDelta({ previousBalance = null, observedBalance = null } = {}) {
	const previous = Number(previousBalance);
	const observed = Number(observedBalance);
	if (!Number.isFinite(previous) || !Number.isFinite(observed)) {
		return null;
	}
	const delta = observed - previous;
	return delta > 0 ? delta : 0;
}

export function evaluatePostCloseSettlementObservation({
	previousBaseBalance,
	observedBaseBalance,
	positionStillOpen,
}) {
	const observedBalanceDelta = computeObservedTokenDelta({
		previousBalance: previousBaseBalance,
		observedBalance: observedBaseBalance,
	});

	if (Number.isFinite(observedBalanceDelta) && observedBalanceDelta > 0) {
		return {
			settled: true,
			signal: "base_balance_delta_observed",
			observed_balance: observedBaseBalance,
			observed_balance_delta: observedBalanceDelta,
		};
	}

	if (positionStillOpen === false) {
		return {
			settled: true,
			signal: "position_absent_from_open_positions",
			observed_balance: observedBaseBalance,
			observed_balance_delta: observedBalanceDelta,
		};
	}

	return {
		settled: false,
		reason: "settlement_signal_not_observed",
	};
}

export async function getWalletTokenBalance({ walletPubkey, mint, getConnection } = {}) {
	if (!walletPubkey || !mint) return null;
	const response = await getConnection().getParsedTokenAccountsByOwner(walletPubkey, {
		mint: new PublicKey(mint),
	});
	return (response.value || []).reduce((sum, account) => {
		const amount = Number(account.account.data.parsed.info.tokenAmount.uiAmount || 0);
		return sum + (Number.isFinite(amount) ? amount : 0);
	}, 0);
}

export async function waitForPostCloseSettlement({
	walletPubkey,
	baseMint,
	positionAddress,
	previousBaseBalance = null,
	maxAttempts = 6,
	delayMs = 1000,
	getConnection,
	getMyPositions,
	log,
}) {
	if (!baseMint && !positionAddress) {
		return { settled: false, reason: "missing_settlement_observation_targets" };
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		let observedBaseBalance = null;
		let positionStillOpen = null;

		try {
			if (baseMint) {
				const response = await getConnection().getParsedTokenAccountsByOwner(walletPubkey, {
					mint: new PublicKey(baseMint),
				});
				observedBaseBalance = (response.value || []).reduce((sum, account) => {
					const amount = Number(account.account.data.parsed.info.tokenAmount.uiAmount || 0);
					return sum + (Number.isFinite(amount) ? amount : 0);
				}, 0);
			}
		} catch (error) {
			log("close_warn", `Settlement check attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
		}

		try {
			if (positionAddress) {
				const openPositions = await getMyPositions({ force: true });
				if (!openPositions?.error && Array.isArray(openPositions?.positions)) {
					positionStillOpen = openPositions.positions.some((position) => position.position === positionAddress);
				}
			}
		} catch (error) {
			log("close_warn", `Settlement open-position check ${attempt}/${maxAttempts} failed: ${error.message}`);
		}

		const observed = evaluatePostCloseSettlementObservation({
			previousBaseBalance,
			observedBaseBalance,
			positionStillOpen,
		});
		if (observed.settled) {
			return {
				settled: true,
				signal: observed.signal,
				observed_balance: observed.observed_balance ?? null,
				observed_balance_delta: observed.observed_balance_delta ?? null,
				position_still_open: positionStillOpen,
				attempts: attempt,
			};
		}

		if (attempt < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return { settled: false, reason: "settlement_signal_not_observed" };
}
