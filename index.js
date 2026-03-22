import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getPositionPnl } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, updatePnlAndCheckExits } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { initMemory, recallForManagement, recallForScreening } from "./memory.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

initMemory();

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

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function deriveExpectedVolumeProfile(snapshot = {}) {
  const feeTvlRatio = asNumber(snapshot.fee_active_tvl_ratio ?? snapshot.fee_tvl_ratio, 0);
  const volume = asNumber(snapshot.volume_window ?? snapshot.volume_24h, 0);
  const volatility = asNumber(snapshot.six_hour_volatility ?? snapshot.volatility, 0);

  if (volatility >= 18 || volume >= 250_000 || feeTvlRatio >= 1.5) return "bursty";
  if (volatility >= 10 || volume >= 75_000 || feeTvlRatio >= 0.5) return "high";
  if (volume >= Math.max(config.screening.minVolume * 8, 10_000) || feeTvlRatio >= 0.12) return "balanced";
  return "low";
}

function deriveTrendBias(pool = {}, tokenInfo = null) {
  const priceChange = asNumber(
    tokenInfo?.stats_1h?.price_change ?? pool.price_change_pct ?? pool.price_change_1h,
    0
  );

  if (priceChange >= 5) return "bullish";
  if (priceChange <= -5) return "bearish";
  return "neutral";
}

function summarizeRuntimeActionResult(result) {
  if (!result) return "no result returned";
  if (result.blocked) return `blocked - ${result.reason || "safety check failed"}`;
  if (result.error) return `error - ${result.error}`;
  if (result.skipped) return `skipped - ${result.reason || "not needed"}`;
  if (result.rebalanced) return `rebalanced into ${result.new_position}`;
  if (result.claimed && result.compounded === false) return result.message || "fees claimed; reinvest left as plan-only";
  if (result.executed === false && result.message) return result.message;
  if (result.success) return result.message || "completed successfully";
  return "completed";
}

function didRuntimeHandleManagementAction(result) {
  return Boolean(
    result
    && !result.blocked
    && !result.error
    && !result.skipped
    && result.success !== false
  );
}

function formatLpWalletScore(scoreResult) {
  if (!scoreResult) return "fetch failed";
  if (scoreResult.message && (!scoreResult.candidates || scoreResult.candidates.length === 0)) return scoreResult.message;

  const ranked = (scoreResult.candidates || []).slice(0, 2);
  if (ranked.length === 0) return "no credible LP wallets scored";

  return ranked.map((wallet, index) => {
    const rank = index + 1;
    const name = wallet.short_owner || wallet.owner || `wallet_${rank}`;
    const totalScore = asNumber(wallet.score_breakdown?.total_score, 0).toFixed(1);
    const winRate = asNumber(wallet.metrics?.win_rate_pct, 0).toFixed(1);
    const feeYield = asNumber(wallet.metrics?.fee_yield_pct_of_capital, 0).toFixed(1);
    const sample = asNumber(wallet.metrics?.sampled_history_count ?? wallet.metrics?.total_lp, 0);
    return `#${rank} ${name} score=${totalScore}, win=${winRate}%, fee_yield=${feeYield}%, sample=${sample}`;
  }).join(" | ");
}

function formatPlannerContext(distributionPlan, tierPlan) {
  if (!distributionPlan?.strategy) return "planner unavailable";

  const dist = distributionPlan.distribution_plan || {};
  const tiers = tierPlan?.range_plan || {};
  const alloc = [dist.lower_allocation, dist.center_allocation, dist.upper_allocation]
    .map((value) => asNumber(value, 0).toFixed(2))
    .join("/");

  return [
    `strategy=${distributionPlan.strategy}`,
    `volume_profile=${distributionPlan.expected_volume_profile}`,
    `trend=${distributionPlan.next_step_inputs?.trend_bias || "neutral"}`,
    `token_bias=${dist.token_bias || "balanced"}`,
    `alloc=${alloc}`,
    `bins=${asNumber(tiers.bins_below, 0)}/${asNumber(tiers.bins_above, 0)}`,
  ].join(" | ");
}

function shouldSkipManagedRuntimeAction(position) {
  const pnlPct = Number.isFinite(Number(position.pnl?.pnl_pct ?? position.pnl_pct))
    ? Number(position.pnl?.pnl_pct ?? position.pnl_pct)
    : null;

  return Boolean(
    position.instruction
    || position.exitAlert
    || (pnlPct != null && pnlPct <= config.management.emergencyPriceDropPct)
    || (pnlPct != null && pnlPct >= config.management.takeProfitFeePct)
  );
}

async function runManagementRuntimeActions(positionData) {
  const runtimeActions = [];

  for (const position of positionData) {
    if (shouldSkipManagedRuntimeAction(position)) continue;

    const feesUsd = asNumber(position.pnl?.unclaimed_fee_usd ?? position.unclaimed_fees_usd, 0);
    const oorMinutes = asNumber(position.minutes_out_of_range, 0);
    const expectedVolumeProfile = deriveExpectedVolumeProfile({
      fee_tvl_ratio: position.fee_tvl_ratio,
      volatility: position.pnl?.volatility ?? position.volatility,
      volume_window: position.volume_window,
    });

    let toolName = null;
    let args = null;
    let reason = null;

    if (position.in_range === false) {
      toolName = "rebalance_on_exit";
      args = {
        position_address: position.position,
        execute: true,
        expected_volume_profile: expectedVolumeProfile,
      };
      reason = oorMinutes > 0 ? `out of range for ${oorMinutes}m` : "out of range";
    } else if (feesUsd >= config.management.minClaimAmount) {
      toolName = "auto_compound_fees";
      args = {
        position_address: position.position,
        execute_reinvest: false,
        expected_volume_profile: expectedVolumeProfile,
      };
      reason = `fees $${feesUsd.toFixed(2)} >= $${config.management.minClaimAmount}`;
    }

    if (!toolName) continue;

    const result = await executeTool(toolName, args);
    runtimeActions.push({
      position: position.position,
      pair: position.pair,
      toolName,
      reason,
      result,
    });
  }

  return runtimeActions;
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
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    timers.managementLastRun = Date.now();
    log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
    let mgmtReport = null;
    let positions = [];
    try {
      // Pre-load all positions + PnL in parallel — LLM gets everything, no fetch steps needed
      const livePositions = await getMyPositions().catch(() => null);
      positions = livePositions?.positions || [];

      if (positions.length === 0) {
        log("cron", "No open positions — triggering screening cycle");
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
        return;
      }

      // Snapshot + PnL fetch in parallel for all positions
      const positionData = await Promise.all(positions.map(async (p) => {
        recordPositionSnapshot(p.pool, p);
        const pnl = await getPositionPnl({ pool_address: p.pool, position_address: p.position }).catch(() => null);
        const recall = recallForPool(p.pool);
        const enriched = {
          ...p,
          pnl_pct: pnl?.pnl_pct ?? p.pnl_pct,
          unclaimed_fees_usd: pnl?.unclaimed_fee_usd ?? p.unclaimed_fees_usd,
          fee_tvl_ratio: pnl?.fee_active_tvl_ratio ?? p.fee_tvl_ratio,
        };
        const memoryHits = recallForManagement(enriched);
        const memoryRecall = memoryHits.length
          ? memoryHits.map((hit) => `[${hit.source}] ${hit.key}: ${hit.answer}`).join(" | ")
          : null;
        const exitAlert = pnl?.pnl_pct != null
          ? updatePnlAndCheckExits(p.position, pnl.pnl_pct, config)
          : null;
        return { ...enriched, pnl, recall, memoryRecall, exitAlert };
      }));

      const runtimeActions = await runManagementRuntimeActions(positionData);
      const handledRuntimeActions = runtimeActions.filter((action) => didRuntimeHandleManagementAction(action.result));
      const attemptedRuntimeActions = runtimeActions.filter((action) => !didRuntimeHandleManagementAction(action.result));
      const handledRuntimeActionMap = new Map(handledRuntimeActions.map((action) => [action.position, action]));
      const attemptedRuntimeActionMap = new Map(attemptedRuntimeActions.map((action) => [action.position, action]));
      const pendingPositionData = positionData.filter((p) => !handledRuntimeActionMap.has(p.position));
      const pendingExitAlerts = pendingPositionData
        .filter((p) => p.exitAlert)
        .map((p) => `- ${p.pair}: ${p.exitAlert}`);

      const handledRuntimeActionBlock = handledRuntimeActions.length > 0
        ? handledRuntimeActions.map((action) => {
          const outcome = summarizeRuntimeActionResult(action.result);
          return `- ${action.pair} (${action.position}): ${action.toolName} [${action.reason}] -> ${outcome}`;
        }).join("\n")
        : "- none";
      const attemptedRuntimeActionBlock = attemptedRuntimeActions.length > 0
        ? attemptedRuntimeActions.map((action) => {
          const outcome = summarizeRuntimeActionResult(action.result);
          return `- ${action.pair} (${action.position}): ${action.toolName} [${action.reason}] -> ${outcome}`;
        }).join("\n")
        : "- none";

      // Build pre-loaded position blocks for the LLM
      const positionBlocks = pendingPositionData.map((p) => {
        const pnl = p.pnl;
        const runtimeAttempt = attemptedRuntimeActionMap.get(p.position);
        const lines = [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          pnl ? `  pnl_pct: ${pnl.pnl_pct}% | pnl_usd: $${pnl.pnl_usd} | unclaimed_fees: $${pnl.unclaimed_fee_usd} | claimed_fees: $${Math.max(0, (pnl.all_time_fees_usd || 0) - (pnl.unclaimed_fee_usd || 0)).toFixed(2)} | value: $${pnl.current_value_usd} | fee_per_tvl_24h: ${pnl.fee_per_tvl_24h ?? "?"}%` : `  pnl: fetch failed`,
          pnl ? `  bins: lower=${pnl.lower_bin} upper=${pnl.upper_bin} active=${pnl.active_bin}` : null,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
          p.exitAlert ? `  exit_alert: ${p.exitAlert}` : null,
          runtimeAttempt ? `  runtime_attempt_this_cycle: ${runtimeAttempt.toolName} -> ${summarizeRuntimeActionResult(runtimeAttempt.result)}` : null,
          p.recall ? `  pool_memory: ${p.recall}` : null,
          p.memoryRecall ? `  learned_memory: ${p.memoryRecall}` : null,
        ].filter(Boolean);
        return lines.join("\n");
      }).join("\n\n");

      if (pendingPositionData.length === 0) {
        mgmtReport = `RUNTIME ACTIONS ALREADY EXECUTED\n${handledRuntimeActionBlock}\n\nNo remaining positions required manager write decisions this cycle.`;
        return;
      }

      // Hive mind pattern consensus (if enabled)
      let hivePatterns = "";
      try {
        const hiveMind = await import("./hive-mind.js");
        if (hiveMind.isEnabled()) {
          const patterns = await hiveMind.queryPatternConsensus();
          const significant = (patterns || []).filter(p => p.count >= 10);
          if (significant.length > 0) {
            hivePatterns = `\nHIVE MIND PATTERNS (supplementary):\n${significant.slice(0, 3).map(p => `[HIVE] ${p.strategy}: ${p.win_rate}% win, ${p.avg_pnl}% avg PnL (${p.count} deploys)`).join("\n")}\n`;
          }
        }
      } catch { /* hive is best-effort */ }

      const { content } = await agentLoop(`
MANAGEMENT CYCLE — ${positions.length} position(s), ${pendingPositionData.length} still actionable after runtime orchestration

RUNTIME ACTIONS ALREADY EXECUTED THIS CYCLE (do not repeat any write action for these positions):
${handledRuntimeActionBlock}

RUNTIME WRITE ATTEMPTS THAT DID NOT COMPLETE (do not retry the same tool on these positions this cycle unless the user explicitly instructs it):
${attemptedRuntimeActionBlock}

PRE-LOADED POSITION DATA (no fetching needed):
${positionBlocks}${hivePatterns}

${pendingExitAlerts.length ? `AUTOMATIC EXIT ALERTS (highest priority — close these immediately):
${pendingExitAlerts.join("\n")}

` : ""}HARD CLOSE RULES — apply in order, first match wins:
1. instruction set AND condition met → CLOSE (highest priority)
2. instruction set AND condition NOT met → HOLD, skip remaining rules
3. pnl_pct <= ${config.management.emergencyPriceDropPct}% → CLOSE (stop loss)
4. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
5. in_range = false → REBALANCE with rebalance_on_exit immediately, unless a higher-priority close rule already fired
6. fee_per_tvl_24h < ${config.management.minFeePerTvl24h} AND age_minutes >= 60 → CLOSE (fee yield too low)
7. fee_active_tvl_ratio < ${config.screening.minFeeActiveTvlRatio} AND volume < $${config.screening.minVolume} → CLOSE (yield dead)

CLAIM RULE: If a position is staying open and unclaimed_fee_usd >= ${config.management.minClaimAmount}, use auto_compound_fees with execute_reinvest=false. Do not call claim_fees directly unless auto_compound_fees is unavailable.

INSTRUCTIONS:
All data is pre-loaded above — do NOT call get_my_positions or get_position_pnl.
Apply the rules to each position and write your report immediately.
Never repeat a write action for any position already listed in RUNTIME ACTIONS ALREADY EXECUTED.
If a position shows runtime_attempt_this_cycle, do not retry that same tool again this cycle. You may still choose a different action or report why no further action is safe.
Only call tools if a remaining position needs to be CLOSED, REBALANCED, or fees need safe-mode compounding.
If you use auto_compound_fees, keep execute_reinvest=false because in-place compounding is still blocked; safe mode claims fees and returns a non-executed reinvest plan.
If all positions STAY and no fees to claim, just write the report with no tool calls.

REPORT FORMAT (one per position):
**[PAIR]** | Age: [X]m | Unclaimed: $[X] | Claimed: $[X] | PnL: [X]%
**Rule:** [number or "none"] | **Decision:** STAY/CLOSE/REBALANCE/COMPOUND | **Reason:** [1 sentence]
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 4096);
      mgmtReport = runtimeActions.length > 0
        ? `RUNTIME ACTIONS ALREADY EXECUTED\n${handledRuntimeActionBlock}\n\nRUNTIME WRITE ATTEMPTS NOT COMPLETED\n${attemptedRuntimeActionBlock}\n\n${content}`
        : content;
    } catch (error) {
      log("cron_error", `Management cycle failed: ${error.message}`);
      mgmtReport = `Management cycle failed: ${error.message}`;
    } finally {
      _managementBusy = false;
      if (telegramEnabled()) {
        if (mgmtReport) sendMessage(`🔄 Management Cycle\n\n${mgmtReport}`).catch(() => {});
        for (const p of positions) {
          if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
            notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
          }
        }
      }
    }
  });

  async function runScreeningCycle() {
    if (_screeningBusy) return;

    // Hard guards — don't even run the agent if preconditions aren't met
    let prePositions, preBalance;
    try {
      [prePositions, preBalance] = await Promise.all([getMyPositions(), getWalletBalances()]);
      if (prePositions.total_positions >= config.risk.maxPositions) {
        log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
        return;
      }
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      if (preBalance.sol < minRequired) {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        return;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      return;
    }

    _screeningBusy = true;
    timers.screeningLastRun = Date.now();
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    let screenReport = null;
    try {
      // Reuse pre-fetched balance — no extra RPC call needed
      const currentBalance = preBalance;
      const deployAmount = computeDeployAmount(currentBalance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

      // Load active strategy
      const activeStrategy = getActiveStrategy();
      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
        : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

      // Pre-load top candidates + all recon data in parallel (saves 4-6 LLM steps)
      const topCandidates = await getTopCandidates({ limit: 5 }).catch(() => null);
      const candidates = topCandidates?.candidates || topCandidates?.pools || [];

      const scorePreloadLimit = Math.min(2, candidates.length);
      const preloadedLpScores = new Map();
      for (const pool of candidates.slice(0, scorePreloadLimit)) {
        const scoreResult = await executeTool("score_top_lpers", { pool_address: pool.pool, limit: 4 });
        preloadedLpScores.set(pool.pool, scoreResult);
      }

      const candidateBlocks = [];
      for (const pool of candidates.slice(0, 5)) {
        const mint = pool.base?.mint;
        const planningPoolData = {
          six_hour_volatility: asNumber(pool.six_hour_volatility ?? pool.volatility, 0),
          volatility: asNumber(pool.six_hour_volatility ?? pool.volatility, 0),
          fee_tvl_ratio: asNumber(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio, 0),
          organic_score: asNumber(pool.organic_score, 0),
          bin_step: asNumber(pool.bin_step, 0),
          price_change_pct: asNumber(pool.price_change_pct, 0),
          active_tvl: asNumber(pool.active_tvl, 0),
          volume_24h: asNumber(pool.volume_24h ?? pool.volume_window, 0),
        };
        const expectedVolumeProfile = deriveExpectedVolumeProfile(pool);
        const [smartWallets, holders, narrative, tokenInfo, poolMemory, distributionPlan, tierPlan] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenHolders({ mint, limit: 100 }) : Promise.resolve(null),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
            Promise.resolve(recallForPool(pool.pool)),
            executeTool("choose_distribution_strategy", {
              pool_data: planningPoolData,
              expected_volume_profile: expectedVolumeProfile,
            }),
            executeTool("calculate_dynamic_bin_tiers", {
              six_hour_volatility: planningPoolData.six_hour_volatility,
              trend_bias: deriveTrendBias(pool),
            }),
          ]);

          const sw   = smartWallets.status === "fulfilled" ? smartWallets.value : null;
          const h    = holders.status === "fulfilled" ? holders.value : null;
          const n    = narrative.status === "fulfilled" ? narrative.value : null;
          const ti   = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
          const mem  = poolMemory.value;
          const scoredLpers = preloadedLpScores.get(pool.pool) || {
            message: `not preloaded (rate-safe budget reserved for top ${scorePreloadLimit} candidate${scorePreloadLimit === 1 ? "" : "s"}; fetch only if decisive)`,
            candidates: [],
          };
          const planner = distributionPlan.status === "fulfilled" ? distributionPlan.value : null;
          const tiering = tierPlan.status === "fulfilled" ? tierPlan.value : null;
          const memoryHits = recallForScreening({
            name: pool.name,
            pair: pool.name,
            base_token: mint,
            bin_step: pool.bin_step,
          });
          const learnedMemory = memoryHits.length
            ? memoryHits.map((hit) => `[${hit.source}] ${hit.key}: ${hit.answer}`).join(" | ")
            : null;

          const momentum = ti?.stats_1h
            ? `1h: price${ti.stats_1h.price_change >= 0 ? "+" : ""}${ti.stats_1h.price_change}%, buyers=${ti.stats_1h.buyers}, net_buyers=${ti.stats_1h.net_buyers}`
            : null;

          // Build compact block
          const lines = [
            `POOL: ${pool.name} (${pool.pool})`,
            `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
            `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
            h ? `  holders: top_10_pct=${h.top_10_real_holders_pct ?? "?"}%, bundlers_pct=${h.bundlers_pct_in_top_100 ?? "?"}%, global_fees_sol=${h.global_fees_sol ?? "?"}` : `  holders: fetch failed`,
            momentum ? `  momentum: ${momentum}` : null,
            n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
            `  lp_wallet_scoring: ${formatLpWalletScore(scoredLpers)}`,
            `  planner: ${formatPlannerContext(planner, tiering)}`,
            mem ? `  pool_memory: ${mem}` : null,
            learnedMemory ? `  learned_memory: ${learnedMemory}` : null,
          ].filter(Boolean);

          candidateBlocks.push(lines.join("\n"));
      }

      let candidateContext = candidateBlocks.length > 0
        ? `\nPRE-LOADED CANDIDATE ANALYSIS (smart wallets, 100-holder distribution, narrative, planner context, and conservative LP-wallet scoring for the top ${scorePreloadLimit} candidate${scorePreloadLimit === 1 ? "" : "s"}):\n${candidateBlocks.join("\n\n")}\n`
        : "";

      // Hive mind consensus (if enabled)
      try {
        const hiveMind = await import("./hive-mind.js");
        if (hiveMind.isEnabled()) {
          const poolAddrs = candidates.map(c => c.pool).filter(Boolean);
          if (poolAddrs.length > 0) {
            const hive = await hiveMind.formatPoolConsensusForPrompt(poolAddrs);
            if (hive) candidateContext += "\n" + hive + "\n";
          }
        }
      } catch { /* hive is best-effort */ }

      const { content } = await agentLoop(`
SCREENING CYCLE — DEPLOY ONLY
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${candidateContext}
DECISION RULES (apply to the pre-loaded candidates above, no re-fetching needed):
- HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL (bundled/scam)
- HARD SKIP if top_10_pct > ${config.screening.maxTop10Pct}% OR bundlers_pct > ${config.screening.maxBundlersPct}%
- SKIP if narrative is empty/null or pure hype with no specific story (unless smart wallets present)
- Bundlers 5–15% are normal, not a skip reason on their own
- Smart wallets present → strong confidence boost
- LP-wallet scoring matters: prefer pools where top scored LPs show real win rate, fee yield, and sample depth
- Use the pre-loaded planner context to bias strategy/range choices before deploy; only override it if a candidate has a clear contradictory signal
- LP-wallet scoring preload is conservative and rate-aware. It is only preloaded for the top ${scorePreloadLimit} candidate${scorePreloadLimit === 1 ? "" : "s"}; for later candidates, only fetch score_top_lpers if the cheaper signals already make that pool a serious finalist.

STEPS:
1. Pick the best candidate from the pre-loaded analysis above. If none pass, report why and stop.
2. Reuse the pre-loaded LP-wallet scoring and planner context in your reasoning. Do not call choose_distribution_strategy or calculate_dynamic_bin_tiers again unless a candidate block explicitly failed to load and the missing data is decisive.
3. Only call score_top_lpers for a later candidate if that pool is already a leading deploy option after the cheaper pre-loaded signals and its LP-wallet score would break the tie.
4. deploy_position directly — it fetches the active bin internally, no separate get_active_bin needed.
   Use ${deployAmount} SOL. Do NOT use a smaller amount — this is compounded from your ${currentBalance.sol.toFixed(3)} SOL wallet.
5. Report: pool chosen, key signals, LP-wallet score takeaway, planner takeaway, deploy outcome.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 4096);
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      _screeningBusy = false;
      if (telegramEnabled()) {
        if (screenReport) sendMessage(`🔍 Screening Cycle\n\n${screenReport}`).catch(() => {});
      }
    }
  }

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
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
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name   = (p.name || "unknown").padEnd(20);
    const ftvl   = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol    = `$${((p.volume_24h || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun  = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions(),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  // Telegram bot
  startPolling(async (text) => {
    if (_managementBusy || _screeningBusy || busy) {
      sendMessage("Agent is busy right now — try again in a moment.").catch(() => {});
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, config.llm.generalModel);
      appendHistory(text, content);
      await sendMessage(content);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  });

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  maxVolatility:    ${s.maxVolatility}`);
      console.log(`  minFeeTvlRatio:   ${s.minFeeTvlRatio}`);
      console.log(`  minOrganic:       ${s.minOrganic}`);
      console.log(`  minHolders:       ${s.minHolders}`);
      console.log(`  maxPriceChangePct: ${s.maxPriceChangePct}`);
      console.log(`  timeframe:        ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
