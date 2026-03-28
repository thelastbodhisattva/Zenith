export async function handleSuccessfulToolSideEffects({
	name,
	normalizedArgs,
	result,
	meta = {},
	workflowId = null,
	executeTool,
	notifySwap,
	notifyDeploy,
	notifyClose,
	log,
	config,
}) {
	if (name === "swap_token" && result.tx) {
		await notifySwap({
			inputSymbol: normalizedArgs.input_mint?.slice(0, 8),
			outputSymbol:
				normalizedArgs.output_mint ===
					"So11111111111111111111111111111111111111112" ||
				normalizedArgs.output_mint === "SOL"
					? "SOL"
					: normalizedArgs.output_mint?.slice(0, 8),
			amountIn: result.amount_in,
			amountOut: result.amount_out,
			tx: result.tx,
		}).catch(() => {});
		return;
	}

	if (name === "deploy_position") {
		await notifyDeploy({
			pair:
				result.pool_name ||
				normalizedArgs.pool_name ||
				normalizedArgs.pool_address?.slice(0, 8),
			amountSol: normalizedArgs.amount_y ?? normalizedArgs.amount_sol ?? 0,
			position: result.position,
			tx: result.txs?.[0] ?? result.tx,
			priceRange: result.price_range,
			binStep: result.bin_step,
			baseFee: result.base_fee,
		}).catch(() => {});
		return;
	}

	if (name === "close_position") {
		await notifyClose({
			pair: result.pool_name || normalizedArgs.position_address?.slice(0, 8),
			pnlUsd: result.pnl_usd ?? 0,
			pnlPct: result.pnl_pct ?? 0,
		}).catch(() => {});
		const swapAmount = Number(result.base_amount_received ?? 0);
		if (!normalizedArgs.skip_swap && result.base_mint && Number.isFinite(swapAmount) && swapAmount > 0) {
			log(
				"executor",
				`Auto-swapping observed close proceeds ${swapAmount} of ${result.base_mint.slice(0, 8)} back to SOL`,
			);
			const autoSwapResult = await executeTool(
				"swap_token",
				{
					input_mint: result.base_mint,
					output_mint: "SOL",
					amount: swapAmount,
				},
				{
					cycle_id: meta.cycle_id || null,
					cycle_type: meta.cycle_type || null,
					regime_label: meta.regime_label || null,
					action_id: workflowId ? `${workflowId}:auto_swap_close` : undefined,
				},
			);
			if (autoSwapResult?.error || autoSwapResult?.blocked) {
				log(
					"executor_warn",
					`Auto-swap after close did not complete: ${autoSwapResult.error || autoSwapResult.reason || "unknown error"}`,
				);
			}
		}
		return;
	}

	if (
		name === "claim_fees" &&
		config.management.autoSwapAfterClaim &&
		result.base_mint
	) {
		const swapAmount = Number(result.base_amount_received ?? 0);
		if (Number.isFinite(swapAmount) && swapAmount > 0) {
			log(
				"executor",
				`Auto-swapping observed claimed proceeds ${swapAmount} of ${result.base_mint.slice(0, 8)} back to SOL`,
			);
			const autoSwapResult = await executeTool(
				"swap_token",
				{
					input_mint: result.base_mint,
					output_mint: "SOL",
					amount: swapAmount,
				},
				{
					cycle_id: meta.cycle_id || null,
					cycle_type: meta.cycle_type || null,
					regime_label: meta.regime_label || null,
					action_id: workflowId ? `${workflowId}:auto_swap_claim` : undefined,
				},
			);
			if (autoSwapResult?.error || autoSwapResult?.blocked) {
				log(
					"executor_warn",
					`Auto-swap after claim did not complete: ${autoSwapResult.error || autoSwapResult.reason || "unknown error"}`,
				);
			}
		}
	}
}
