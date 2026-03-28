export function mergeOpenPositions(livePositions = [], trackedPositions = []) {
	const merged = new Map();
	for (const position of [...livePositions, ...trackedPositions]) {
		if (!position?.position) continue;
		merged.set(position.position, position);
	}
	return Array.from(merged.values());
}

export async function runSafetyChecksWithDeps(name, args, meta = {}, deps = {}) {
	const {
		generalApprovalRequiredTools,
		evaluateGeneralWriteApproval,
		validateRecordedRiskOpeningPreflight,
		getRuntimeHealth,
		getWalletBalancesRuntime,
		getPoolGovernanceMetadataRuntime,
		getMyPositionsRuntime,
		evaluatePortfolioGuard,
		buildOpenPositionPnlInputs,
		getTrackedPositions,
		evaluateDeployAdmission,
		getPoolDeployCooldown,
		config,
	} = deps;

	if (!meta.cycle_id && generalApprovalRequiredTools.has(name)) {
		const amountSol = name === "deploy_position"
			? args.amount_y ?? args.amount_sol ?? 0
			: name === "swap_token" && (args.output_mint === "SOL" || args.input_mint === "SOL")
				? Number(args.amount || 0)
				: null;
		const approval = evaluateGeneralWriteApproval({
			tool_name: name,
			pool_address: args.pool_address || null,
			position_address: args.position_address || null,
			amount_sol: amountSol,
		});
		if (!approval.pass) {
			return {
				pass: false,
				reason: approval.reason,
			};
		}
	}

	switch (name) {
		case "deploy_position": {
			if (!meta.cycle_id) {
				const amountSol = args.amount_y ?? args.amount_sol ?? 0;
				const preflight = validateRecordedRiskOpeningPreflight(getRuntimeHealth().preflight, {
					tool_name: name,
					pool_address: args.pool_address,
					amount_sol: amountSol,
				});
				if (!preflight.pass) {
					return {
						pass: false,
						reason: preflight.reason,
					};
				}
			}

			const balance = await getWalletBalancesRuntime();
			if (args?.pool_address) {
				const governanceMetadata = await getPoolGovernanceMetadataRuntime({
					pool_address: args.pool_address,
				});
				if (governanceMetadata?.error) {
					return {
						pass: false,
						reason: `Deploy governance metadata unavailable: ${governanceMetadata.error}`,
					};
				}
				args.base_mint = governanceMetadata.base_mint;
				args.bin_step = governanceMetadata.bin_step;
			}
			const positions = await getMyPositionsRuntime({ force: true });
			if (positions?.error) {
				return {
					pass: false,
					reason: `Unable to verify open positions: ${positions.error}`,
				};
			}
			if (!Array.isArray(positions?.positions)) {
				return {
					pass: false,
					reason: "Unable to verify open positions: positions payload missing positions array.",
				};
			}
			const portfolioGuard = evaluatePortfolioGuard({
				portfolioSnapshot: balance,
				openPositionPnls: buildOpenPositionPnlInputs(positions.positions),
			});
			const trackedPositions = getTrackedPositions(true);
			const combinedPositions = mergeOpenPositions(
				positions.positions,
				trackedPositions,
			);
			const deployAdmission = evaluateDeployAdmission({
				config,
				poolAddress: args.pool_address,
				baseMint: args.base_mint,
				amountY: args.amount_y ?? args.amount_sol ?? 0,
				amountX: args.amount_x ?? 0,
				binStep: args.bin_step,
				positions: combinedPositions,
				positionsCount: combinedPositions.length,
				walletSol: balance.sol,
				portfolioGuard,
				poolCooldown: getPoolDeployCooldown({
					pool_address: args.pool_address,
				}),
			});

			return deployAdmission.pass
				? { pass: true }
				: { pass: false, reason: deployAdmission.message };
		}

		case "swap_token": {
			return { pass: true };
		}

		case "rebalance_on_exit": {
			if (!args?.position_address) {
				return {
					pass: false,
					reason: "position_address is required.",
				};
			}
			return { pass: true };
		}

		case "auto_compound_fees": {
			const portfolioGuard = evaluatePortfolioGuard();
			if (portfolioGuard.blocked) {
				return {
					pass: false,
					reason: `Portfolio guard active: ${portfolioGuard.reason}`,
				};
			}
			if (!args?.position_address) {
				return {
					pass: false,
					reason: "position_address is required.",
				};
			}
			return { pass: true };
		}

		case "claim_fees":
		case "close_position": {
			if (!args?.position_address) {
				return {
					pass: false,
					reason: "position_address is required.",
				};
			}

			const positions = await getMyPositionsRuntime({ force: true });
			const openPosition = positions.positions?.find(
				(position) => position.position === args.position_address,
			);
			if (!openPosition) {
				return {
					pass: false,
					reason: `Position ${args.position_address} is not currently open.`,
				};
			}

			return { pass: true };
		}

		default:
			return { pass: true };
	}
}
