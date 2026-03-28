import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendActionLifecycle } from "../action-journal.js";
import { config } from "../config.js";
import {
	addLesson,
	clearAllLessons,
	clearPerformance,
	getPerformanceHistory,
	listLessons,
	pinLesson,
	removeLessonsByKeyword,
	unpinLesson,
} from "../lessons.js";
import { log, logAction } from "../logger.js";
import { recallMemory, rememberFact } from "../memory.js";
import {
	consumeOneShotGeneralWriteApproval,
	evaluateGeneralWriteApproval,
} from "../operator-controls.js";
import { evaluatePortfolioGuard } from "../portfolio-guards.js";
import { validateRecordedRiskOpeningPreflight } from "../preflight.js";
import {
	addPoolNote,
	getPoolDeployCooldown,
	getPoolMemory,
} from "../pool-memory.js";
import { buildOpenPositionPnlInputs } from "../runtime-helpers.js";
import { estimateInitialValueUsd } from "../runtime-helpers.js";
import { getRuntimeHealth } from "../runtime-health.js";
import { evaluateDeployAdmission } from "../runtime-policy.js";
import {
	addSmartWallet,
	checkSmartWalletsOnPool,
	listSmartWallets,
	removeSmartWallet,
} from "../smart-wallets.js";
import {
	getTrackedPositions,
	recordToolOutcome,
	setPositionInstruction,
} from "../state.js";
import {
	addStrategy,
	getStrategy,
	listStrategies,
	removeStrategy,
	setActiveStrategy,
} from "../strategy-library.js";
import { notifyClose, notifyDeploy, notifySwap } from "../telegram.js";
import {
	addToBlacklist,
	listBlacklist,
	removeFromBlacklist,
} from "../token-blacklist.js";
import {
	autoCompoundFees,
	calculateDynamicBinTiers,
	chooseDistributionStrategy,
	claimFees,
	closePosition,
	deployPosition,
	getPoolGovernanceMetadata,
	getActiveBin,
	getMyPositions,
	getPositionPnl,
	getWalletPositions,
	rebalanceOnExit,
	searchPools,
} from "./dlmm.js";
import {
	appendWriteLifecycleEntry,
	attachWriteDecisionContext,
	recordWriteToolOutcome,
} from "./executor-lifecycle.js";
import {
	runSafetyChecksWithDeps,
} from "./executor-safety.js";
import { handleSuccessfulToolSideEffects } from "./executor-side-effects.js";
import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import { getPoolInfo, scoreTopLPers, studyTopLPers } from "./study.js";
import { getTokenHolders, getTokenInfo, getTokenNarrative } from "./token.js";
import { getWalletBalances, swapToken } from "./wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");

const executorTestOverrides = {
	getMyPositions: null,
	getWalletBalances: null,
	getPoolGovernanceMetadata: null,
	recordToolOutcome: null,
	tools: {},
};

export function setExecutorTestOverrides(overrides = {}) {
	if (Object.hasOwn(overrides, "getMyPositions"))
		executorTestOverrides.getMyPositions = overrides.getMyPositions;
	if (Object.hasOwn(overrides, "getWalletBalances"))
		executorTestOverrides.getWalletBalances = overrides.getWalletBalances;
	if (Object.hasOwn(overrides, "getPoolGovernanceMetadata"))
		executorTestOverrides.getPoolGovernanceMetadata =
			overrides.getPoolGovernanceMetadata;
	if (Object.hasOwn(overrides, "recordToolOutcome"))
		executorTestOverrides.recordToolOutcome = overrides.recordToolOutcome;
	if (overrides.tools)
		executorTestOverrides.tools = {
			...executorTestOverrides.tools,
			...overrides.tools,
		};
}

export function resetExecutorTestOverrides() {
	executorTestOverrides.getMyPositions = null;
	executorTestOverrides.getWalletBalances = null;
	executorTestOverrides.getPoolGovernanceMetadata = null;
	executorTestOverrides.recordToolOutcome = null;
	executorTestOverrides.tools = {};
}

function getMyPositionsRuntime(args = {}) {
	return executorTestOverrides.getMyPositions
		? executorTestOverrides.getMyPositions(args)
		: getMyPositions(args);
}

function getWalletBalancesRuntime(args = {}) {
	return executorTestOverrides.getWalletBalances
		? executorTestOverrides.getWalletBalances(args)
		: getWalletBalances(args);
}

function getPoolGovernanceMetadataRuntime(args = {}) {
	return executorTestOverrides.getPoolGovernanceMetadata
		? executorTestOverrides.getPoolGovernanceMetadata(args)
		: getPoolGovernanceMetadata(args);
}

function recordToolOutcomeRuntime(payload) {
	if (executorTestOverrides.recordToolOutcome) {
		executorTestOverrides.recordToolOutcome(payload);
		return;
	}
	recordToolOutcome(payload);
}

function getToolImplementation(name) {
	return executorTestOverrides.tools[name] || toolMap[name];
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) {
	_cronRestarter = fn;
}

let _autonomousWriteSuppressed = false;
let _writeSuppressionReason = null;
let _writeSuppressionCode = null;
let _writeSuppressionIncidentKey = null;

export function setAutonomousWriteSuppression({
	suppressed,
	reason = null,
	code = null,
	incidentKey = null,
} = {}) {
	_autonomousWriteSuppressed = Boolean(suppressed);
	_writeSuppressionReason = _autonomousWriteSuppressed
		? reason || "manual review required"
		: null;
	_writeSuppressionCode = _autonomousWriteSuppressed ? code || null : null;
	_writeSuppressionIncidentKey = _autonomousWriteSuppressed ? incidentKey || null : null;
}

export function getAutonomousWriteSuppression() {
	return {
		suppressed: _autonomousWriteSuppressed,
		reason: _writeSuppressionReason,
		code: _writeSuppressionCode,
		incident_key: _writeSuppressionIncidentKey,
	};
}

// Map tool names to implementations
const toolMap = {
	discover_pools: discoverPools,
	get_top_candidates: getTopCandidates,
	get_pool_detail: getPoolDetail,
	get_position_pnl: getPositionPnl,
	get_active_bin: getActiveBin,
	choose_distribution_strategy: chooseDistributionStrategy,
	calculate_dynamic_bin_tiers: calculateDynamicBinTiers,
	deploy_position: deployPosition,
	rebalance_on_exit: rebalanceOnExit,
	auto_compound_fees: autoCompoundFees,
	get_my_positions: getMyPositions,
	get_wallet_positions: getWalletPositions,
	search_pools: searchPools,
	get_token_info: getTokenInfo,
	get_token_holders: getTokenHolders,
	get_token_narrative: getTokenNarrative,
	add_smart_wallet: addSmartWallet,
	remove_smart_wallet: removeSmartWallet,
	list_smart_wallets: listSmartWallets,
	check_smart_wallets_on_pool: checkSmartWalletsOnPool,
	claim_fees: claimFees,
	close_position: closePosition,
	get_wallet_balance: getWalletBalances,
	swap_token: swapToken,
	get_top_lpers: studyTopLPers,
	study_top_lpers: studyTopLPers,
	score_top_lpers: scoreTopLPers,
	get_pool_info: getPoolInfo,
	set_position_note: ({ position_address, instruction }) => {
		const ok = setPositionInstruction(position_address, instruction || null);
		if (!ok)
			return { error: `Position ${position_address} not found in state` };
		return {
			saved: true,
			position: position_address,
			instruction: instruction || null,
		};
	},
	self_update: async () => {
		try {
			const result = execSync("git pull", {
				cwd: process.cwd(),
				encoding: "utf8",
			}).trim();
			if (result.includes("Already up to date")) {
				return {
					success: true,
					updated: false,
					message: "Already up to date — no restart needed.",
				};
			}
			// Delay restart so this tool response (and Telegram message) gets sent first
			setTimeout(() => {
				const child = spawn(process.execPath, process.argv.slice(1), {
					detached: true,
					stdio: "inherit",
					cwd: process.cwd(),
				});
				child.unref();
				process.exit(0);
			}, 3000);
			return {
				success: true,
				updated: true,
				message: `Updated! Restarting in 3s...\n${result}`,
			};
		} catch (e) {
			return { success: false, error: e.message };
		}
	},
	get_performance_history: getPerformanceHistory,
	add_strategy: addStrategy,
	list_strategies: listStrategies,
	get_strategy: getStrategy,
	set_active_strategy: setActiveStrategy,
	remove_strategy: removeStrategy,
	get_pool_memory: getPoolMemory,
	add_pool_note: addPoolNote,
	add_to_blacklist: addToBlacklist,
	remove_from_blacklist: removeFromBlacklist,
	list_blacklist: listBlacklist,
	add_lesson: ({ rule, tags, pinned, role }) => {
		addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
		return { saved: true, rule, pinned: !!pinned, role: role || "all" };
	},
	remember_fact: ({ nugget, key, value }) => rememberFact(nugget, key, value),
	recall_memory: ({ query, nugget }) => recallMemory(query, nugget),
	pin_lesson: ({ id }) => pinLesson(id),
	unpin_lesson: ({ id }) => unpinLesson(id),
	list_lessons: ({ role, pinned, tag, limit } = {}) =>
		listLessons({ role, pinned, tag, limit }),
	clear_lessons: ({ mode, keyword }) => {
		if (mode === "all") {
			const n = clearAllLessons();
			log("lessons", `Cleared all ${n} lessons`);
			return { cleared: n, mode: "all" };
		}
		if (mode === "performance") {
			const n = clearPerformance();
			log("lessons", `Cleared ${n} performance records`);
			return { cleared: n, mode: "performance" };
		}
		if (mode === "keyword") {
			if (!keyword) return { error: "keyword required for mode=keyword" };
			const n = removeLessonsByKeyword(keyword);
			log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
			return { cleared: n, mode: "keyword", keyword };
		}
		return { error: "invalid mode" };
	},
	update_config: ({ changes, reason = "" }) => {
		// Flat key → config section mapping (covers everything in config.js)
		const CONFIG_MAP = {
			// screening
			minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
			minTvl: ["screening", "minTvl"],
			maxTvl: ["screening", "maxTvl"],
			minVolume: ["screening", "minVolume"],
			minOrganic: ["screening", "minOrganic"],
			minHolders: ["screening", "minHolders"],
			minMcap: ["screening", "minMcap"],
			maxMcap: ["screening", "maxMcap"],
			minBinStep: ["screening", "minBinStep"],
			maxBinStep: ["screening", "maxBinStep"],
			timeframe: ["screening", "timeframe"],
			category: ["screening", "category"],
			minTokenFeesSol: ["screening", "minTokenFeesSol"],
			maxBundlersPct: ["screening", "maxBundlersPct"],
			maxTop10Pct: ["screening", "maxTop10Pct"],
			// protections
			protectionsEnabled: ["protections", "enabled"],
			maxRecentRealizedLossUsd: ["protections", "maxRecentRealizedLossUsd"],
			maxDrawdownPct: ["protections", "maxDrawdownPct"],
			maxOpenUnrealizedLossUsd: ["protections", "maxOpenUnrealizedLossUsd"],
			recentLossWindowHours: ["protections", "recentLossWindowHours"],
			stopLossStreakLimit: ["protections", "stopLossStreakLimit"],
			portfolioPauseMinutes: ["protections", "pauseMinutes"],
			maxReviewedCloses: ["protections", "maxReviewedCloses"],
			recoveryResumeOverrideMinutes: [
				"protections",
				"recoveryResumeOverrideMinutes",
			],
			// management
			minClaimAmount: ["management", "minClaimAmount"],
			autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
			outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
			outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
			minVolumeToRebalance: ["management", "minVolumeToRebalance"],
			emergencyPriceDropPct: ["management", "emergencyPriceDropPct"],
			stopLossPct: ["management", "stopLossPct"],
			takeProfitFeePct: ["management", "takeProfitFeePct"],
			trailingTakeProfit: ["management", "trailingTakeProfit"],
			trailingTriggerPct: ["management", "trailingTriggerPct"],
			trailingDropPct: ["management", "trailingDropPct"],
			minSolToOpen: ["management", "minSolToOpen"],
			deployAmountSol: ["management", "deployAmountSol"],
			gasReserve: ["management", "gasReserve"],
			positionSizePct: ["management", "positionSizePct"],
			// risk
			maxPositions: ["risk", "maxPositions"],
			maxDeployAmount: ["risk", "maxDeployAmount"],
			// schedule
			managementIntervalMin: ["schedule", "managementIntervalMin"],
			screeningIntervalMin: ["schedule", "screeningIntervalMin"],
			// models
			managementModel: ["llm", "managementModel"],
			screeningModel: ["llm", "screeningModel"],
			generalModel: ["llm", "generalModel"],
			// strategy
			binsBelow: ["strategy", "binsBelow"],
		};

		const applied = {};
		const unknown = [];

		// Build case-insensitive lookup
		const CONFIG_MAP_LOWER = Object.fromEntries(
			Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]]),
		);

		for (const [key, val] of Object.entries(changes)) {
			const match = CONFIG_MAP[key]
				? [key, CONFIG_MAP[key]]
				: CONFIG_MAP_LOWER[key.toLowerCase()];
			if (!match) {
				unknown.push(key);
				continue;
			}
			applied[match[0]] = val;
		}

		if (Object.keys(applied).length === 0) {
			log(
				"config",
				`update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`,
			);
			return { success: false, unknown, reason };
		}

		// Apply to live config immediately
		const effectiveApplied = {};
		for (const [key, val] of Object.entries(applied)) {
			const [section, field] = CONFIG_MAP[key];
			const before = config[section][field];
			if (Object.is(before, val)) continue;
			effectiveApplied[key] = val;
			config[section][field] = val;
			log(
				"config",
				`update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`,
			);
		}

		if (Object.keys(effectiveApplied).length === 0) {
			return { success: true, applied: {}, unknown, reason, noop: true };
		}

		// Persist to user-config.json
		let userConfig = {};
		if (fs.existsSync(USER_CONFIG_PATH)) {
			try {
				userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
			} catch {
				/**/
			}
		}
		Object.assign(userConfig, effectiveApplied);
		userConfig._lastAgentTune = new Date().toISOString();
		fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

		// Restart cron jobs if intervals changed
		const intervalChanged =
			effectiveApplied.managementIntervalMin != null ||
			effectiveApplied.screeningIntervalMin != null;
		if (intervalChanged && _cronRestarter) {
			_cronRestarter();
			log(
				"config",
				`Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`,
			);
		}

		// Save as a lesson — but skip ephemeral per-deploy interval changes
		// (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
		//  the rule is already in the system prompt, storing it 75+ times is pure noise)
		const lessonsKeys = Object.keys(effectiveApplied).filter(
			(k) => k !== "managementIntervalMin" && k !== "screeningIntervalMin",
		);
		if (lessonsKeys.length > 0) {
			const summary = lessonsKeys
				.map((k) => `${k}=${effectiveApplied[k]}`)
				.join(", ");
			addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, [
				"self_tune",
				"config_change",
			]);
		}

		log(
			"config",
			`Agent self-tuned: ${JSON.stringify(effectiveApplied)} — ${reason}`,
		);
		return { success: true, applied: effectiveApplied, unknown, reason };
	},
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
	"deploy_position",
	"rebalance_on_exit",
	"auto_compound_fees",
	"claim_fees",
	"close_position",
	"swap_token",
]);
const GENERAL_APPROVAL_REQUIRED_TOOLS = new Set([...WRITE_TOOLS, "update_config"]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args, meta = {}) {
	const startTime = Date.now();
	let normalizedArgs = args;
	let workflowId = null;

	function appendManualReviewTerminal(reason) {
		appendWriteLifecycleEntry({
			appendActionLifecycle,
			workflowId,
			lifecycle: "manual_review",
			name,
			args: normalizedArgs,
			meta,
			reason,
		});
	}

	// ─── Validate tool exists ─────────────────
	const fn = getToolImplementation(name);
	if (!fn) {
		const error = `Unknown tool: ${name}`;
		log("error", error);
		return { error };
	}

	if (name === "deploy_position" && normalizedArgs) {
		const wallet = await getWalletBalancesRuntime({}).catch(() => null);
		const solPrice = Number(wallet?.sol_price) || 0;
		const solLeg = Number(normalizedArgs.amount_y ?? normalizedArgs.amount_sol ?? 0);
		const derivedInitialValueUsd = solPrice > 0 && solLeg > 0
			? estimateInitialValueUsd({ amountSol: solLeg, solPrice })
			: null;
		normalizedArgs = {
			...normalizedArgs,
			initial_value_usd: derivedInitialValueUsd,
		};
		if (derivedInitialValueUsd != null) {
			log(
				"executor",
				`Derived initial_value_usd=$${normalizedArgs.initial_value_usd} from runtime data for deploy_position`,
			);
		}
	}

	// ─── Pre-execution safety checks ──────────
	if (!meta.cycle_id && GENERAL_APPROVAL_REQUIRED_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
		const safetyCheck = await runSafetyChecks(name, normalizedArgs, meta);
		if (!safetyCheck.pass) {
			log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
			return {
				blocked: true,
				reason: safetyCheck.reason,
			};
		}
	}

	if (WRITE_TOOLS.has(name)) {
		if (_autonomousWriteSuppressed) {
			const reason =
				_writeSuppressionReason ||
				"manual review required before autonomous writes can resume";
			recordToolOutcomeRuntime({
				tool: name,
				outcome: "blocked",
				reason,
				metadata: {
					pool_address: normalizedArgs?.pool_address || null,
					position_address: normalizedArgs?.position_address || null,
					cycle_id: meta.cycle_id || null,
					action_id: meta.action_id || null,
					blocked_by_recovery: true,
				},
			});
			return {
				blocked: true,
				reason,
			};
		}

		workflowId =
			meta.action_id ||
			`${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		normalizedArgs = attachWriteDecisionContext(
			normalizedArgs,
			meta,
			workflowId,
		);
		appendWriteLifecycleEntry({
			appendActionLifecycle,
			workflowId,
			lifecycle: "intent",
			name,
			args: normalizedArgs,
			meta,
		});

		if (name === "rebalance_on_exit") {
			normalizedArgs = {
				...normalizedArgs,
				journal_workflow_id: workflowId,
			};
		}

		const safetyCheck = await runSafetyChecks(name, normalizedArgs, meta);
		if (!safetyCheck.pass) {
			log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
			appendManualReviewTerminal("write_intent_blocked_by_safety_checks");
			recordWriteToolOutcome({
				recordToolOutcome: recordToolOutcomeRuntime,
				tool: name,
				outcome: "blocked",
				reason: safetyCheck.reason,
				args: normalizedArgs,
				meta,
			});
			return {
				blocked: true,
				reason: safetyCheck.reason,
			};
		}
	}

	// ─── Execute ──────────────────────────────
	try {
		const result = await fn(normalizedArgs);
		const duration = Date.now() - startTime;
		const success = result?.success !== false && !result?.error;

		logAction({
			tool: name,
			args: normalizedArgs,
			result: summarizeResult(result),
			duration_ms: duration,
			success,
			cycle_id: meta.cycle_id || null,
			action_id: meta.action_id || null,
		});

		if (success) {
			if (WRITE_TOOLS.has(name)) {
				appendWriteLifecycleEntry({
					appendActionLifecycle,
					workflowId,
					lifecycle: "completed",
					name,
					args: {
						...normalizedArgs,
						position_address:
							normalizedArgs?.position_address || result?.position || null,
						pool_address:
							normalizedArgs?.pool_address ||
							result?.pool ||
							result?.pool_address ||
							null,
					},
					meta,
				});
				recordWriteToolOutcome({
					recordToolOutcome: recordToolOutcomeRuntime,
					tool: name,
					outcome: "success",
					args: normalizedArgs,
					meta,
					result,
				});
			}
			await handleSuccessfulToolSideEffects({
				name,
				normalizedArgs,
				result,
				meta,
				workflowId,
				executeTool,
				notifySwap,
				notifyDeploy,
				notifyClose,
				log,
				config,
			});
		if (!meta.cycle_id && GENERAL_APPROVAL_REQUIRED_TOOLS.has(name)) {
				consumeOneShotGeneralWriteApproval({
					tool_name: name,
					pool_address: normalizedArgs?.pool_address || null,
					position_address: normalizedArgs?.position_address || result?.position || null,
					amount_sol:
						name === "deploy_position"
							? normalizedArgs?.amount_y ?? normalizedArgs?.amount_sol ?? 0
							: name === "swap_token" && (normalizedArgs?.output_mint === "SOL" || normalizedArgs?.input_mint === "SOL")
								? Number(normalizedArgs?.amount || 0)
								: null,
				});
			}
		}

		if (!success && WRITE_TOOLS.has(name)) {
			const reason = result?.error || "write_tool_reported_unsuccessful_result";
			appendManualReviewTerminal(reason);
			recordWriteToolOutcome({
				recordToolOutcome: recordToolOutcomeRuntime,
				tool: name,
				outcome: "error",
				reason,
				args: normalizedArgs,
				meta,
				result,
			});
		}

		return result;
	} catch (error) {
		const duration = Date.now() - startTime;

		if (WRITE_TOOLS.has(name)) {
			appendManualReviewTerminal(error.message || "write_tool_execution_error");
			recordWriteToolOutcome({
				recordToolOutcome: recordToolOutcomeRuntime,
				tool: name,
				outcome: "error",
				reason: error.message,
				args: normalizedArgs,
				meta,
			});
		}

		logAction({
			tool: name,
			args: normalizedArgs,
			error: error.message,
			duration_ms: duration,
			success: false,
			cycle_id: meta.cycle_id || null,
			action_id: meta.action_id || null,
		});

		// Return error to LLM so it can decide what to do
		return {
			error: error.message,
			tool: name,
		};
	}
}

/**
 * Run safety checks before executing write operations.
 */
export async function runSafetyChecks(name, args, meta = {}) {
	return runSafetyChecksWithDeps(name, args, meta, {
		generalApprovalRequiredTools: GENERAL_APPROVAL_REQUIRED_TOOLS,
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
	});
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
	const str = JSON.stringify(result);
	if (str.length > 1000) {
		return `${str.slice(0, 1000)}...(truncated)`;
	}
	return result;
}
