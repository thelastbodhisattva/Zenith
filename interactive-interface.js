import readline from "node:readline";

import { formatCandidateInspection, formatCandidates, formatRangeStatus, inspectCandidate } from "./screening-intel.js";
import { formatInteractiveHelp, renderInteractiveStartup } from "./startup-interface.js";

export async function runInteractiveInterface({
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
  getOperatorControlSnapshot,
  startPolling,
  sendMessage,
  sendHTML,
  getEvaluationSummary,
  getStateSummary,
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
  deployAmountSol,
} = {}) {
  const state = {
    busy: false,
    cronStarted: false,
    startupCandidates: [],
    sessionHistory: [],
  };
  const MAX_HISTORY = 20;

  function appendHistory(userMsg, assistantMsg) {
    state.sessionHistory.push({ role: "user", content: userMsg });
    state.sessionHistory.push({ role: "assistant", content: assistantMsg });
    if (state.sessionHistory.length > MAX_HISTORY) {
      state.sessionHistory.splice(0, state.sessionHistory.length - MAX_HISTORY);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  function refreshPrompt() {
    rl.setPrompt(buildPrompt());
    rl.prompt(true);
  }

  function launchCron() {
    if (bootRecoveryBlockActive) {
      const recoveryBlock = summarizeRecoveryBlock(bootRecovery);
      console.log(`Autonomous cycles are paused: boot recovery blocked startup because ${recoveryBlock.headline}.`);
      console.log(`Recovery detail: ${recoveryBlock.detail}`);
      refreshPrompt();
      return;
    }
    if (!state.cronStarted) {
      state.cronStarted = true;
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      refreshPrompt();
    }
  }

  async function runBusy(fn) {
    if (state.busy) {
      console.log("Agent is busy, please wait...");
      rl.prompt();
      return;
    }
    state.busy = true;
    rl.pause();
    try {
      await fn();
    } catch (e) {
      console.error(`Error: ${e.message}`);
    } finally {
      state.busy = false;
      rl.setPrompt(buildPrompt());
      rl.resume();
      rl.prompt();
    }
  }

  setInterval(() => {
    if (!state.busy) refreshPrompt();
  }, 10_000);

  state.busy = true;
  try {
    state.startupCandidates = await renderInteractiveStartup({
      bootRecoveryBlockActive,
      bootRecovery,
      summarizeRecoveryBlock,
      getStartupSnapshot,
      getWalletBalances,
      getMyPositions,
      getTopCandidates,
      isFailClosedResult,
      refreshRuntimeHealth,
      buildProviderHealthFromSnapshot,
      buildStaticProviderHealth,
      secretHealth,
      telegramEnabled,
      formatRangeStatus,
      formatCandidates,
    });
  } finally {
    state.busy = false;
  }

  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  startPolling(async (text) => {
    if (state.busy) {
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

    if (text === "/recovery") {
      try {
        const report = getRecoveryWorkflowReport({ limit: 5 });
        const suppression = getAutonomousWriteSuppression();
        await sendMessage(formatRecoveryReport(report, suppression));
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (text === "/health") {
      try {
        await sendMessage(await buildOperationalHealthReport({
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
        }));
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    const operatorCommand = await handleOperatorCommandText({
      text,
      source: "telegram",
      config,
      getRecoveryWorkflowReport,
      getAutonomousWriteSuppression,
      clearPortfolioGuardPause,
      setAutonomousWriteSuppression,
      acknowledgeRecoveryResume,
      armGeneralWriteTools,
      disarmGeneralWriteTools,
      getOperatorControlSnapshot,
      refreshRuntimeHealth,
    });
    if (operatorCommand.handled) {
      await sendMessage(operatorCommand.message);
      return;
    }

    state.busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, state.sessionHistory, agentRole, config.llm.generalModel, null, {
        allowDangerousTools: agentRole !== "GENERAL" || getOperatorControlSnapshot().general_write_arm.armed,
      });
      appendHistory(text, content);
      await sendMessage(content);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      state.busy = false;
      refreshPrompt();
    }
  });

  console.log(formatInteractiveHelp(deployAmountSol));
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const pick = Number.parseInt(input, 10);
    if (!Number.isNaN(pick) && pick >= 1 && pick <= state.startupCandidates.length) {
      await runBusy(async () => {
        const pool = state.startupCandidates[pick - 1];
        console.log(`\nDeploying ${deployAmountSol} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${deployAmountSol} SOL into pool ${pool.pool} (${pool.name}) using deploy_position directly. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, deploy_position with ${deployAmountSol} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    if (input === "/stop") {
      await shutdown("user command");
      return;
    }

    if (input === "/health") {
      await runBusy(async () => {
        console.log(await buildOperationalHealthReport({
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
        }));
      });
      return;
    }

    if (input === "/status") {
      await runBusy(async () => {
        const snapshot = await getStartupSnapshot({ getWalletBalances, getMyPositions, getTopCandidates });
        if (isFailClosedResult(snapshot)) {
          console.log(`\nStatus unavailable: [${snapshot.reason_code}] ${snapshot.message}\n`);
          return;
        }
        const { wallet, positions } = snapshot;
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = formatRangeStatus(p);
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
        const snapshot = await getStartupSnapshot({ force: true, getWalletBalances, getMyPositions, getTopCandidates });
        if (isFailClosedResult(snapshot)) {
          console.log(`\nCandidates unavailable: [${snapshot.reason_code}] ${snapshot.message}\n`);
          return;
        }
        const { candidates, total_eligible, total_screened } = snapshot;
        state.startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    const candidateMatch = input.match(/^\/candidate\s+(\d+)$/i);
    if (candidateMatch) {
      await runBusy(async () => {
        const idx = Number(candidateMatch[1]) - 1;
        if (idx < 0 || idx >= state.startupCandidates.length) {
          console.log("\nInvalid candidate number. Use /candidates first.\n");
          return;
        }
        const inspection = await inspectCandidate(state.startupCandidates[idx], executeTool);
        console.log(`\n${formatCandidateInspection(inspection)}\n`);
      });
      return;
    }

    if (input === "/evaluation") {
      await runBusy(async () => {
        const evaluation = getEvaluationSummary(5);
        console.log("\nRecent evaluation summary:\n");
        console.log(`  management_cycles: ${evaluation.counters.management_cycles}`);
        console.log(`  screening_cycles:  ${evaluation.counters.screening_cycles}`);
        console.log(`  candidates_scored: ${evaluation.counters.candidates_scored}`);
        console.log(`  candidates_blocked:${evaluation.counters.candidates_blocked}`);
        console.log(`  runtime_handled:   ${evaluation.counters.runtime_actions_handled}`);
        console.log(`  runtime_attempted: ${evaluation.counters.runtime_actions_attempted}`);
        console.log(`  tool_blocks:       ${evaluation.counters.tool_blocks}`);
        console.log(`  tool_errors:       ${evaluation.counters.tool_errors}`);
        console.log(`  write_successes:   ${evaluation.counters.write_successes}`);
        if (evaluation.recent_cycles.length > 0) {
          console.log("\n  Recent cycles:");
          for (const cycle of evaluation.recent_cycles) {
            console.log(`    - ${cycle.ts}: ${cycle.cycle_type} / ${cycle.status} / ${JSON.stringify(cycle.summary)}`);
          }
        }
        if (evaluation.recent_tool_outcomes.length > 0) {
          console.log("\n  Recent tool outcomes:");
          for (const outcome of evaluation.recent_tool_outcomes) {
            console.log(`    - ${outcome.ts}: ${outcome.tool} / ${outcome.outcome}${outcome.reason ? ` / ${outcome.reason}` : ""}`);
          }
        }
        console.log();
      });
      return;
    }

    if (input === "/failures") {
      await runBusy(async () => {
        const bundles = listEvidenceBundles(5);
        if (bundles.length === 0) {
          console.log("\nNo bad-cycle evidence bundles recorded yet.\n");
          return;
        }
        console.log("\nRecent bad-cycle evidence bundles:\n");
        for (const bundle of bundles) {
          console.log(`  - ${bundle.file}: ${bundle.cycle_type} / ${bundle.status}${bundle.reason_code ? ` / ${bundle.reason_code}` : ""}${bundle.error ? ` / ${bundle.error}` : ""}`);
        }
        console.log();
      });
      return;
    }

    const failureMatch = input.match(/^\/failure\s+(.+)$/i);
    if (failureMatch) {
      await runBusy(async () => {
        console.log(formatEvidenceBundle(getEvidenceBundle(failureMatch[1].trim())));
      });
      return;
    }

    if (input === "/recovery") {
      await runBusy(async () => {
        const report = getRecoveryWorkflowReport({ limit: 10 });
        const suppression = getAutonomousWriteSuppression();
        console.log(formatRecoveryReport(report, suppression));
      });
      return;
    }

    if (input === "/journal") {
      await runBusy(async () => {
        console.log(formatActionJournalReport(listActionJournalEntries, 12));
      });
      return;
    }

    const replayMatch = input.match(/^\/replay\s+(.+)$/i);
    if (replayMatch) {
      await runBusy(async () => {
        console.log(formatReplayEnvelope(getReplayEnvelope(replayMatch[1].trim())));
      });
      return;
    }

    const reconcileMatch = input.match(/^\/reconcile\s+(.+)$/i);
    if (reconcileMatch) {
      await runBusy(async () => {
        console.log(formatReplayReview(getReplayReview(reconcileMatch[1].trim())));
      });
      return;
    }

    if (input === "/review") {
      await runBusy(async () => {
        const stats = getReplayReviewStats(25);
        console.log("\nReplay-backed review:\n");
        console.log(`  total: ${stats.total}`);
        console.log(`  screening: ${stats.screening}`);
        console.log(`  management: ${stats.management}`);
        console.log(`  fail_closed: ${stats.fail_closed}`);
        console.log(`  matches: ${stats.matches}`);
        console.log(`  mismatches: ${stats.mismatches}`);
        if (stats.counterfactual) {
          console.log(`  counterfactual_reviews: ${stats.counterfactual.total_reviews}`);
          console.log(`  divergent_alternates: ${stats.counterfactual.divergent_alternates}`);
          console.log(`  resolved_counterfactuals: ${stats.counterfactual.resolved_reviews}`);
          console.log(`  divergent_losses_to_review: ${stats.counterfactual.divergent_resolved_losses}`);
          if (stats.counterfactual.recent_reviews.length > 0) {
            console.log("\n  Recent counterfactuals:");
            for (const review of stats.counterfactual.recent_reviews.slice(0, 5)) {
              const alternateSummary = review.alternates
                .map((row) => `${row.regime}:${row.selected_pool || "none"}${row.diverged_from_active ? "*" : ""}`)
                .join(", ");
              const realized = review.realized_outcome
                ? ` | realized=${review.realized_outcome.pnl_pct ?? "n/a"}% (${review.realized_outcome.usefulness_hint})`
                : "";
              console.log(`    - ${review.cycle_id}: active=${review.active_regime}:${review.active_selected_pool || "none"} | alternates=${alternateSummary}${realized}`);
            }
          }
        }
        if (stats.recent_cycles.length > 0) {
          console.log("\n  Recent cycles:");
          for (const row of stats.recent_cycles) {
            console.log(`    - ${row.cycle_id}: ${row.cycle_type}${row.reason_code ? ` / ${row.reason_code}` : ""}`);
          }
        }
        console.log();
      });
      return;
    }

    const operatorCommandInput = input.startsWith("/arm") || input.startsWith("/disarm") || input.startsWith("/resume ")
      ? input
      : null;
    if (operatorCommandInput) {
      await runBusy(async () => {
        const operatorCommand = await handleOperatorCommandText({
          text: operatorCommandInput,
          source: "repl",
          config,
          getRecoveryWorkflowReport,
          getAutonomousWriteSuppression,
          clearPortfolioGuardPause,
          setAutonomousWriteSuppression,
          acknowledgeRecoveryResume,
          armGeneralWriteTools,
          disarmGeneralWriteTools,
          getOperatorControlSnapshot,
          refreshRuntimeHealth,
        });
        if (operatorCommand.handled) {
          console.log(`\n${operatorCommand.message}\n`);
        }
      });
      return;
    }

    if (input === "/performance") {
      await runBusy(async () => {
        const summary = getPerformanceSummary();
        const history = getPerformanceHistory({ hours: 168, limit: 5 });
        const lpOverview = await getLpOverview().catch(() => null);
        if (!summary && !lpOverview) {
          console.log("\nNo closed-position performance recorded yet.\n");
          return;
        }
        console.log("\nPerformance summary:\n");
        if (summary) {
          console.log(`  total_positions_closed:   ${summary.total_positions_closed}`);
          console.log(`  total_pnl_usd:            ${summary.total_pnl_usd}`);
          console.log(`  total_inventory_pnl_usd:  ${summary.total_inventory_pnl_usd}`);
          console.log(`  total_fee_component_usd:  ${summary.total_fee_component_usd}`);
          console.log(`  avg_pnl_pct:              ${summary.avg_pnl_pct}%`);
          console.log(`  avg_range_efficiency_pct: ${summary.avg_range_efficiency_pct}%`);
          console.log(`  avg_operational_touches:  ${summary.avg_operational_touch_count}`);
          console.log(`  win_rate_pct:             ${summary.win_rate_pct}%`);
        }
        if (lpOverview) {
          console.log("\n  LP Agent overview:");
          console.log(`    total_pnl_usd:    ${lpOverview.total_pnl_usd}`);
          console.log(`    total_pnl_sol:    ${lpOverview.total_pnl_sol}`);
          console.log(`    total_fees_usd:   ${lpOverview.total_fees_usd}`);
          console.log(`    total_fees_sol:   ${lpOverview.total_fees_sol}`);
          console.log(`    win_rate_pct:     ${lpOverview.win_rate_pct}%`);
          console.log(`    open_positions:   ${lpOverview.open_positions}`);
          console.log(`    closed_positions: ${lpOverview.closed_positions}`);
          console.log(`    avg_hold_hours:   ${lpOverview.avg_hold_hours}`);
          console.log(`    roi_pct:          ${lpOverview.roi_pct}%`);
        }
        if (summary && history.positions.length > 0) {
          console.log("\n  Recent closes:");
          for (const row of history.positions) {
            console.log(`    - ${row.pool_name}: pnl=${row.pnl_usd} usd | inventory=${row.inventory_pnl_usd} | fees=${row.fee_component_usd} | touches=${row.operational_touch_count} | reason=${row.close_reason}`);
          }
        }
        console.log();
      });
      return;
    }

    if (input === "/proof") {
      await runBusy(async () => {
        const proof = getStrategyProofSummary({ hours: 168 });
        if (!proof) {
          console.log("\nNo closed-position proof data recorded yet.\n");
          return;
        }
        console.log("\nStrategy proof summary:\n");
        console.log(`  positions_analyzed:         ${proof.positions_analyzed}`);
        console.log(`  total_inventory_pnl_usd:    ${proof.total_inventory_pnl_usd}`);
        console.log(`  total_fee_component_usd:    ${proof.total_fee_component_usd}`);
        console.log(`  fee_share_of_total_pnl_pct: ${proof.fee_share_of_total_pnl_pct}%`);
        console.log(`  avg_operational_touches:    ${proof.avg_operational_touch_count}`);
        console.log("\n  Strategy breakdown:");
        for (const row of proof.strategy_breakdown) {
          console.log(`    - ${row.strategy}: count=${row.count} | win=${row.win_rate_pct}% | avg_pnl=${row.avg_pnl_pct}% | inv=${row.avg_inventory_pnl_usd} | fees=${row.avg_fee_component_usd} | touches=${row.avg_operational_touch_count}`);
        }
        if (proof.top_close_reasons.length > 0) {
          console.log("\n  Top close reasons:");
          for (const row of proof.top_close_reasons) {
            console.log(`    - ${row.reason}: ${row.count}`);
          }
        }
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      const evaluation = getStateSummary().evaluation;
      console.log("\nCurrent screening thresholds:");
      for (const [label, value] of getScreeningThresholdSummary(s)) {
        console.log(`  ${label}: ${value}`);
      }
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      if (evaluation?.counters) {
        console.log(`  Screening cycles logged: ${evaluation.counters.screening_cycles}`);
        console.log(`  Candidates scored: ${evaluation.counters.candidates_scored} | blocked: ${evaluation.counters.candidates_blocked}`);
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
        const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");
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
          "GENERAL",
          config.llm.generalModel,
          null,
          { allowDangerousTools: true }
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
        const fs = await import("node:fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, state.sessionHistory, "GENERAL", config.llm.generalModel, null, {
        allowDangerousTools: getOperatorControlSnapshot().general_write_arm.armed,
      });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));
}
