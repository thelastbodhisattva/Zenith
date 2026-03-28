import "dotenv/config";
import cron from "node-cron";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getPositionPnl } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { discoverPools, getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount, secretHealth } from "./config.js";
import {
	evolveThresholds,
	getPerformanceHistory,
	getPerformanceSummary,
	getStrategyProofSummary,
	recoverThresholdRolloutState,
} from "./lessons.js";
import { getScreeningThresholdSummary } from "./runtime-helpers.js";
import { executeTool, getAutonomousWriteSuppression, registerCronRestarter, setAutonomousWriteSuppression } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getEvaluationSummary, getLastBriefingDate, getTrackedPositions, recordCycleEvaluation, setLastBriefingDate, updatePnlAndCheckExits } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { getNegativeRegimeCooldown, recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { initMemory, recallForManagement } from "./memory.js";
import { classifyManagementModelGate, deriveExpectedVolumeProfile, isPnlSignalStale, resolveTargetManagementInterval } from "./runtime-policy.js";
import { evaluateScreeningCycleAdmission } from "./runtime-policy.js";
import { getLpOverview } from "./tools/lp-overview.js";
import { appendReplayEnvelope, createCycleId } from "./cycle-trace.js";
import { classifyRuntimeFailure, isFailClosedResult, validateStartupSnapshot } from "./degraded-mode.js";
import { getStartupSnapshot } from "./startup-snapshot.js";
import { runManagementRuntimeActions } from "./management-runtime.js";
import { listEvidenceBundles, writeEvidenceBundle } from "./evidence-bundles.js";
import { getEvidenceBundle } from "./evidence-bundles.js";
import {
	getRecoveryWorkflowReport,
	isBootRecoveryOverrideAllowed,
	runBootRecovery,
	summarizeRecoveryBlock,
} from "./boot-recovery.js";
import { getOverlappingCycleType, shouldTriggerFollowOnScreening } from "./cycle-overlap.js";
import { handleCycleOverlap } from "./cycle-harness.js";
import { clearPortfolioGuardPause, evaluatePortfolioGuard } from "./portfolio-guards.js";
import { acknowledgeRecoveryResume, armGeneralWriteTools, disarmGeneralWriteTools, getOperatorControlSnapshot } from "./operator-controls.js";
import { updateRuntimeHealth } from "./runtime-health.js";
import { formatReplayReview, getReplayEnvelope, getReplayReview, getReplayReviewStats } from "./replay-review.js";
import {
	listActionJournalEntries,
	listActionJournalWorkflowsByCycle,
} from "./action-journal.js";
import { getNegativeRegimeMemory } from "./negative-regime-memory.js";
import { handleOperatorCommandText } from "./operator-command-handlers.js";
import {
  buildOperationalHealthReport,
  buildProviderHealthFromSnapshot,
  buildStaticProviderHealth,
  createHeadlessTelegramCommandHandler,
  createRuntimeHealthRefresher,
  formatActionJournalReport,
  formatEvidenceBundle,
  formatRecoveryReport,
  formatReplayEnvelope,
} from "./control-plane-helpers.js";
import {
  asNumber,
  buildCandidateContext,
  deriveTrendBias,
  didRuntimeHandleManagementAction,
  evaluateCandidateIntel,
  formatFinalistInspectionBlock,
  inspectCandidate,
  roundMetric,
  summarizeRuntimeActionResult,
} from "./screening-intel.js";
import { createManagementCycleRunner } from "./management-cycle-runner.js";
import { createScreeningCycleRunner } from "./screening-cycle-runner.js";
import { runInteractiveInterface } from "./interactive-interface.js";
import { runNonInteractiveStartup } from "./startup-interface.js";
import {
  applyRegimeHysteresis,
  classifyRuntimeRegime,
  getRegimePack,
  getPerformanceSizingMultiplier,
  getRiskSizingMultiplier,
  listCounterfactualRegimes,
  resolveRegimePackContext,
} from "./regime-packs.js";
import { appendCounterfactualReview } from "./counterfactual-review.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

initMemory();

const thresholdRolloutRecovery = recoverThresholdRolloutState(config, {
	trigger: "startup",
});
if (thresholdRolloutRecovery?.status && thresholdRolloutRecovery.status !== "clear") {
	log("evolve_recovery", `Threshold rollout recovery status: ${thresholdRolloutRecovery.status}`);
}

const refreshRuntimeHealth = createRuntimeHealthRefresher({
  updateRuntimeHealth,
  getAutonomousWriteSuppression,
  getRecoveryWorkflowReport,
  getOperatorControlSnapshot,
});

const bootRecovery = await runBootRecovery({
  observeOpenPositions: () => getMyPositions({ force: true }),
  observeTrackedPositions: () => getTrackedPositions(true),
});

const recoveryResumeOverride = getOperatorControlSnapshot().recovery_resume_override;
const bootRecoveryOverrideActive = isBootRecoveryOverrideAllowed(
	bootRecovery,
	recoveryResumeOverride,
);
const bootRecoveryBlockActive = bootRecovery.suppress_autonomous_writes && !bootRecoveryOverrideActive;

if (bootRecoveryOverrideActive) {
  setAutonomousWriteSuppression({ suppressed: false });
  log(
    "recovery_override",
    `Autonomous writes resumed due to persisted operator override until ${recoveryResumeOverride.override_until} (${recoveryResumeOverride.reason || "no reason provided"})`
  );
} else if (bootRecoveryBlockActive) {
  const reason = bootRecovery.reason_code === "JOURNAL_INVALID"
    ? `action journal invalid (${bootRecovery.journal_parse_errors.length} parse error(s))`
    : `manual review required for ${bootRecovery.parked_manual_review_workflows.length} workflow(s)`;
  setAutonomousWriteSuppression({
		suppressed: true,
		reason,
		code: bootRecovery.reason_code,
		incidentKey: bootRecovery.incident_key,
	});
  log("recovery_block", `Autonomous write activity suppressed at boot: ${reason}`);
} else {
  setAutonomousWriteSuppression({ suppressed: false });
}

refreshRuntimeHealth({
  startup: {
    status: "boot_recovery_complete",
    reason: bootRecovery.reason_code || null,
  },
  provider_health: buildStaticProviderHealth({ secretHealth, telegramEnabled }),
});

const DEPLOY  = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function enforceManagementIntervalFromPositions(positions) {
  const { interval, maxVolatility } = resolveTargetManagementInterval(positions);
  if (config.schedule.managementIntervalMin === interval) {
    return { changed: false, interval, maxVolatility };
  }

  const previous = config.schedule.managementIntervalMin;
  config.schedule.managementIntervalMin = interval;
  log("cron", `Management interval adjusted ${previous}m -> ${interval}m (max open-position volatility: ${maxVolatility})`);

  if (cronStarted) startCronJobs();
  return { changed: true, interval, maxVolatility };
}

function buildPrompt() {
  const mgmt  = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn  = formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0;

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  _cronTasks = [];
  cronStarted = false;
}

export function startCronJobs() {
  const screeningCooldownMs = 5 * 60 * 1000;
  stopCronJobs(); // stop any running tasks before (re)starting
  cronStarted = true;
  const runManagementCycle = createManagementCycleRunner({
    log,
    config,
    getMyPositions,
    getWalletBalances,
    validateStartupSnapshot,
    classifyRuntimeFailure,
		appendReplayEnvelope,
		writeEvidenceBundle,
    enforceManagementIntervalFromPositions,
    recordPositionSnapshot,
    getPositionPnl,
    recallForPool,
    recallForManagement,
    isPnlSignalStale,
    updatePnlAndCheckExits,
    evaluatePortfolioGuard,
		runManagementRuntimeActions,
		listActionJournalWorkflowsByCycle,
		executeTool,
    didRuntimeHandleManagementAction,
    classifyManagementModelGate,
    summarizeRuntimeActionResult,
    roundMetric,
    agentLoop,
    shouldTriggerFollowOnScreening,
    runTriggeredScreening: async () => {
      const triggeredCycleId = createCycleId("screening");
      await runScreeningCycle({ cycleId: triggeredCycleId });
    },
    recordCycleEvaluation,
    refreshRuntimeHealth,
    telegramEnabled,
    sendMessage,
    notifyOutOfRange,
    getManagementBusy: () => _managementBusy,
    getScreeningBusy: () => _screeningBusy,
    getScreeningLastTriggered: () => _screeningLastTriggered,
    setManagementBusy: (value) => { _managementBusy = value; },
    setManagementLastRun: (value) => { timers.managementLastRun = value; },
  });

  const runScreeningCycle = createScreeningCycleRunner({
    log,
    config,
    getMyPositions,
    getWalletBalances,
    discoverPools,
    getTopCandidates,
    classifyRuntimeFailure,
    validateStartupSnapshot,
    appendReplayEnvelope,
    writeEvidenceBundle,
    getActiveStrategy,
    computeDeployAmount,
    asNumber,
    deriveExpectedVolumeProfile,
    executeTool,
    inspectCandidate,
    deriveTrendBias,
    evaluateCandidateIntel,
    formatFinalistInspectionBlock,
    buildCandidateContext,
    roundMetric,
    agentLoop,
    evaluatePortfolioGuard,
    evaluateScreeningCycleAdmission,
    getPerformanceSummary,
    classifyRuntimeRegime,
    applyRegimeHysteresis,
    resolveRegimePackContext,
    listCounterfactualRegimes,
    getRegimePack,
    getPerformanceSizingMultiplier,
    getRiskSizingMultiplier,
    getNegativeRegimeCooldown,
    getNegativeRegimeMemory,
		appendCounterfactualReview,
		listActionJournalWorkflowsByCycle,
		recordCycleEvaluation,
    refreshRuntimeHealth,
    telegramEnabled,
    sendMessage,
    setScreeningBusy: (value) => { _screeningBusy = value; },
    setScreeningLastTriggered: (value) => { _screeningLastTriggered = value; },
    setScreeningLastRun: (value) => { timers.screeningLastRun = value; },
  });

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    const overlapWith = getOverlappingCycleType({
      cycleType: "management",
      managementBusy: _managementBusy,
      screeningBusy: _screeningBusy,
    });
		if (overlapWith) {
			handleCycleOverlap({
				cycleType: "management",
				overlapWith,
				createCycleId,
				log,
				appendReplayEnvelope,
				recordCycleEvaluation,
				refreshRuntimeHealth,
				listActionJournalWorkflowsByCycle,
				overlapInputs: {
					cycleType: "management",
					managementBusy: _managementBusy,
					screeningBusy: _screeningBusy,
				},
			});
			return;
		}
    const cycleId = createCycleId("management");
    await runManagementCycle({ cycleId, screeningCooldownMs });
  });

  const runScreeningScheduled = async () => {
    const overlapWith = getOverlappingCycleType({
      cycleType: "screening",
      managementBusy: _managementBusy,
      screeningBusy: _screeningBusy,
    });
		if (overlapWith) {
			handleCycleOverlap({
				cycleType: "screening",
				overlapWith,
				createCycleId,
				log,
				appendReplayEnvelope,
				recordCycleEvaluation,
				refreshRuntimeHealth,
				listActionJournalWorkflowsByCycle,
				overlapInputs: {
					cycleType: "screening",
					managementBusy: _managementBusy,
					screeningBusy: _screeningBusy,
				},
			});
			return;
		}
    const cycleId = createCycleId("screening");
    await runScreeningCycle({ cycleId });
  };

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningScheduled);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

        Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
      refreshRuntimeHealth({
        cycles: {
          health: {
            status: "completed",
            reason: null,
            at: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
      refreshRuntimeHealth({
        cycles: {
          health: {
            status: "failed",
            reason: error.message,
            at: new Date().toISOString(),
          },
        },
      });
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  await runInteractiveInterface({
    buildPrompt,
    bootRecovery,
    bootRecoveryBlockActive,
    summarizeRecoveryBlock,
    startCronJobs,
    maybeRunMissedBriefing,
    getStartupSnapshot,
    getWalletBalances,
    getMyPositions,
    getTopCandidates,
    isFailClosedResult,
    buildOperationalHealthReport,
    buildStaticProviderHealth,
    buildProviderHealthFromSnapshot,
    refreshRuntimeHealth,
    getOperatorControlSnapshot,
    secretHealth,
    telegramEnabled,
    generateBriefing,
    getRecoveryWorkflowReport,
    getAutonomousWriteSuppression,
    formatRecoveryReport,
    handleOperatorCommandText,
    clearPortfolioGuardPause,
    setAutonomousWriteSuppression,
    acknowledgeRecoveryResume,
    armGeneralWriteTools,
    disarmGeneralWriteTools,
    log,
    agentLoop,
    config,
    startPolling,
    sendMessage,
    sendHTML,
    getEvaluationSummary,
    getStateSummary: () => ({ evaluation: getEvaluationSummary() }),
    listEvidenceBundles,
    formatEvidenceBundle,
    getEvidenceBundle,
    formatActionJournalReport,
    listActionJournalEntries,
    formatReplayEnvelope,
    getReplayEnvelope,
    formatReplayReview,
    getReplayReview,
    getReplayReviewStats,
    getPerformanceSummary,
    getPerformanceHistory,
    getLpOverview,
    getStrategyProofSummary,
    getScreeningThresholdSummary,
    evolveThresholds,
    reloadScreeningThresholds,
    executeTool,
    shutdown,
    deployAmountSol: DEPLOY,
  });
} else {
  const onHeadlessTelegramMessage = createHeadlessTelegramCommandHandler({
		handleOperatorCommandText: async ({ text, source }) => handleOperatorCommandText({
			text,
			source,
			config,
			getRecoveryWorkflowReport,
			getAutonomousWriteSuppression,
			setAutonomousWriteSuppression,
			acknowledgeRecoveryResume,
			armGeneralWriteTools,
			disarmGeneralWriteTools,
			getOperatorControlSnapshot,
			refreshRuntimeHealth,
		}),
		buildOperationalHealthReport: async () => buildOperationalHealthReport({
			getStartupSnapshot,
			getWalletBalances,
			getMyPositions,
			getTopCandidates,
			isFailClosedResult,
			buildStaticProviderHealth,
			buildProviderHealthFromSnapshot,
			refreshRuntimeHealth,
			getOperatorControlSnapshot,
			secretHealth,
			telegramEnabled,
		}),
		getRecoveryWorkflowReport,
		getAutonomousWriteSuppression,
		formatRecoveryReport,
		sendMessage,
	});
  await runNonInteractiveStartup({
    bootRecoveryBlockActive,
    bootRecovery,
    summarizeRecoveryBlock,
    log,
    startCronJobs,
    maybeRunMissedBriefing,
		startPolling,
		onTelegramMessage: onHeadlessTelegramMessage,
  });
}
