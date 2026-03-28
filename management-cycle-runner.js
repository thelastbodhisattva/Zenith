import { finalizeCycleRun } from "./cycle-harness.js";

export function createManagementCycleRunner(deps) {
  return async function runManagementCycle({ cycleId, screeningCooldownMs } = {}) {
    const {
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
      runTriggeredScreening,
      recordCycleEvaluation,
      refreshRuntimeHealth,
      telegramEnabled,
      sendMessage,
      notifyOutOfRange,
      getManagementBusy,
      getScreeningBusy,
      getScreeningLastTriggered,
      setManagementBusy,
      setManagementLastRun,
    } = deps;

    if (getManagementBusy()) return;
    setManagementBusy(true);
    setManagementLastRun(Date.now());
    log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);

    let mgmtReport = null;
    let managementEvaluation = null;
    let positions = [];
    let walletSnapshot = null;
    let triggerFollowOnScreening = false;
    let positionData = [];
    let runtimeActions = [];

		const appendManagementReplayEnvelope = (inputs, actions) => {
			appendReplayEnvelope({
				cycle_id: cycleId,
				cycle_type: "management",
        position_inputs: inputs,
				runtime_actions: actions.map((action) => ({
					position: action.position,
					tool: action.toolName,
					rule: action.rule,
					reason: action.reason,
					action_id: action.actionId,
				})),
				write_workflows: listActionJournalWorkflowsByCycle(cycleId),
			});
		};

    try {
      const [livePositionsResult, walletSnapshotResult] = await Promise.all([
        getMyPositions().catch((error) => ({ error: error.message })),
        getWalletBalances().catch(() => null),
      ]);
      const livePositions = livePositionsResult;
      walletSnapshot = walletSnapshotResult;
      if (!livePositions || livePositions.error || !Array.isArray(livePositions.positions)) {
        const failure = validateStartupSnapshot({
          wallet: { sol: 0 },
          positions: livePositions,
          candidates: { candidates: [] },
        }) || classifyRuntimeFailure(new Error(livePositions?.error || "positions unavailable"), { invalidState: !livePositions || !Array.isArray(livePositions?.positions) });
        managementEvaluation = {
          cycle_id: cycleId,
          cycle_type: "management",
          status: "failed_precheck",
          summary: {
            reason_code: failure.reason_code,
            error: failure.message,
          },
          positions: [],
        };
        appendReplayEnvelope({
          cycle_id: cycleId,
          cycle_type: "management",
          reason_code: failure.reason_code,
          error: failure.message,
        });
        writeEvidenceBundle({
          cycle_id: cycleId,
          cycle_type: "management",
          status: "failed_precheck",
          reason_code: failure.reason_code,
          error: failure.message,
          written_at: new Date().toISOString(),
        });
        return;
      }

      positions = livePositions?.positions || [];
      const intervalAdjustment = enforceManagementIntervalFromPositions(positions);

      if (positions.length === 0) {
        log("cron", "No open positions - triggering screening cycle");
        managementEvaluation = {
          cycle_id: cycleId,
          cycle_type: "management",
          status: "empty_positions",
          summary: {
            positions_total: 0,
            pending_positions: 0,
            runtime_actions_handled: 0,
            runtime_actions_attempted: 0,
            enforced_management_interval_min: intervalAdjustment.interval,
            max_open_position_volatility: intervalAdjustment.maxVolatility,
          },
          positions: [],
        };
        appendManagementReplayEnvelope([], []);
        triggerFollowOnScreening = shouldTriggerFollowOnScreening({
          positionsCount: positions.length,
          screeningBusy: getScreeningBusy(),
          screeningLastTriggered: getScreeningLastTriggered(),
          screeningCooldownMs,
        });
        return;
      }

      positionData = await Promise.all(positions.map(async (p) => {
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
        const pnlStale = isPnlSignalStale({ pnl });
        const exitAlert = pnl?.pnl_pct != null
          ? updatePnlAndCheckExits(p.position, pnl.pnl_pct, config, { stale: pnlStale })
          : null;
        return { ...enriched, pnl, recall, memoryRecall, exitAlert };
      }));

      evaluatePortfolioGuard({
        portfolioSnapshot: walletSnapshot,
        openPositionPnls: positionData.map((position) => position.pnl).filter(Boolean),
      });

      runtimeActions = await runManagementRuntimeActions(positionData, {
        cycleId,
        config,
        executeTool,
      });
      const handledRuntimeActions = runtimeActions.filter((action) => didRuntimeHandleManagementAction(action.result));
      const attemptedRuntimeActions = runtimeActions.filter((action) => !didRuntimeHandleManagementAction(action.result));
      const handledRuntimeActionMap = new Map(handledRuntimeActions.map((action) => [action.position, action]));
      const attemptedRuntimeActionMap = new Map(attemptedRuntimeActions.map((action) => [action.position, action]));
      const pendingPositionData = positionData.filter((p) => !handledRuntimeActionMap.has(p.position));
      const modelManagedPositions = pendingPositionData.filter((p) => classifyManagementModelGate(p).route === "model");
      const pendingExitAlerts = pendingPositionData.filter((p) => p.exitAlert).map((p) => `- ${p.pair}: ${p.exitAlert}`);

      const handledRuntimeActionBlock = handledRuntimeActions.length > 0
        ? handledRuntimeActions.map((action) => `- ${action.pair} (${action.position}): ${action.toolName} [${action.reason}] -> ${summarizeRuntimeActionResult(action.result)}`).join("\n")
        : "- none";
      const attemptedRuntimeActionBlock = attemptedRuntimeActions.length > 0
        ? attemptedRuntimeActions.map((action) => `- ${action.pair} (${action.position}): ${action.toolName} [${action.reason}] -> ${summarizeRuntimeActionResult(action.result)}`).join("\n")
        : "- none";

      const positionBlocks = modelManagedPositions.map((p) => {
        const pnl = p.pnl;
        const runtimeAttempt = attemptedRuntimeActionMap.get(p.position);
        const lines = [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          pnl ? `  pnl_pct: ${pnl.pnl_pct}% | pnl_usd: $${pnl.pnl_usd} | unclaimed_fees: $${pnl.unclaimed_fee_usd} | claimed_fees: $${Math.max(0, (pnl.all_time_fees_usd || 0) - (pnl.unclaimed_fee_usd || 0)).toFixed(2)} | value: $${pnl.current_value_usd} | fee_per_tvl_24h: ${pnl.fee_per_tvl_24h ?? "?"}%` : "  pnl: fetch failed",
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
        managementEvaluation = {
          cycle_id: cycleId,
          cycle_type: "management",
          status: "runtime_only",
          summary: {
            positions_total: positions.length,
            pending_positions: 0,
            runtime_actions_handled: handledRuntimeActions.length,
            runtime_actions_attempted: attemptedRuntimeActions.length,
            enforced_management_interval_min: intervalAdjustment.interval,
            max_open_position_volatility: intervalAdjustment.maxVolatility,
          },
          positions: positionData.slice(0, 8).map((p) => ({
            pair: p.pair,
            position: p.position,
            in_range: p.in_range,
            out_of_range_direction: p.out_of_range_direction || null,
            unclaimed_fee_usd: roundMetric(p.pnl?.unclaimed_fee_usd ?? p.unclaimed_fees_usd),
            exit_alert: p.exitAlert || null,
          })),
        };
        appendManagementReplayEnvelope(positionData, runtimeActions);
        return;
      }

      if (modelManagedPositions.length === 0) {
        mgmtReport = `RUNTIME ACTIONS ALREADY EXECUTED\n${handledRuntimeActionBlock}\n\nRUNTIME WRITE ATTEMPTS NOT COMPLETED\n${attemptedRuntimeActionBlock}\n\nNo remaining positions required model evaluation this cycle.`;
        managementEvaluation = {
          cycle_id: cycleId,
          cycle_type: "management",
          status: "runtime_determined",
          summary: {
            positions_total: positions.length,
            pending_positions: pendingPositionData.length,
            model_positions: 0,
            runtime_actions_handled: handledRuntimeActions.length,
            runtime_actions_attempted: attemptedRuntimeActions.length,
            enforced_management_interval_min: intervalAdjustment.interval,
            max_open_position_volatility: intervalAdjustment.maxVolatility,
          },
          positions: pendingPositionData.slice(0, 8).map((p) => ({
            pair: p.pair,
            position: p.position,
            in_range: p.in_range,
            out_of_range_direction: p.out_of_range_direction || null,
            instruction: p.instruction || null,
            runtime_attempted: attemptedRuntimeActionMap.has(p.position),
          })),
        };
        appendManagementReplayEnvelope(positionData, runtimeActions);
        return;
      }

      const { content } = await agentLoop(`
        MANAGEMENT CYCLE - ${positions.length} position(s), ${modelManagedPositions.length} still require model evaluation after runtime orchestration

RUNTIME ACTIONS ALREADY EXECUTED THIS CYCLE (do not repeat any write action for these positions):
${handledRuntimeActionBlock}

RUNTIME WRITE ATTEMPTS THAT DID NOT COMPLETE (do not retry the same tool on these positions this cycle unless the user explicitly instructs it):
${attemptedRuntimeActionBlock}

PRE-LOADED POSITION DATA (no fetching needed):
${positionBlocks}

${pendingExitAlerts.length ? `AUTOMATIC EXIT ALERTS (already handled by runtime this cycle):
${pendingExitAlerts.join("\n")}

` : ""}INSTRUCTION RULES ONLY:
1. instruction set AND condition met -> CLOSE (highest priority)
2. instruction set AND condition NOT met -> HOLD

INSTRUCTIONS:
All data is pre-loaded above - do NOT call get_my_positions or get_position_pnl.
Only evaluate positions that still carry an instruction.
Never repeat a write action for any position already listed in RUNTIME ACTIONS ALREADY EXECUTED.
If a position shows runtime_attempt_this_cycle, do not retry that same tool again this cycle. You may still choose a different action or report why no further action is safe.
Only call tools if an instruction condition is met and a close is required.
If all positions STAY and no fees to claim, just write the report with no tool calls.

REPORT FORMAT (one per position):
**[PAIR]** | Age: [X]m | Unclaimed: $[X] | Claimed: $[X] | PnL: [X]%
**Instruction:** [met / not met] | **Decision:** STAY/CLOSE | **Reason:** [1 sentence]
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 4096, {
        toolContext: {
          cycle_id: cycleId,
          cycle_type: "management",
        },
      });
      mgmtReport = runtimeActions.length > 0
        ? `RUNTIME ACTIONS ALREADY EXECUTED\n${handledRuntimeActionBlock}\n\nRUNTIME WRITE ATTEMPTS NOT COMPLETED\n${attemptedRuntimeActionBlock}\n\n${content}`
        : content;
      managementEvaluation = {
        cycle_id: cycleId,
        cycle_type: "management",
        status: "completed",
        summary: {
          positions_total: positions.length,
          pending_positions: pendingPositionData.length,
          model_positions: modelManagedPositions.length,
          runtime_actions_handled: handledRuntimeActions.length,
          runtime_actions_attempted: attemptedRuntimeActions.length,
          exit_alerts: pendingExitAlerts.length,
          enforced_management_interval_min: intervalAdjustment.interval,
          max_open_position_volatility: intervalAdjustment.maxVolatility,
        },
          positions: pendingPositionData.slice(0, 8).map((p) => ({
            pair: p.pair,
            position: p.position,
          in_range: p.in_range,
          out_of_range_direction: p.out_of_range_direction || null,
          unclaimed_fee_usd: roundMetric(p.pnl?.unclaimed_fee_usd ?? p.unclaimed_fees_usd),
          exit_alert: p.exitAlert || null,
            memory_hits: p.memoryRecall ? 1 : 0,
          })),
        };
      appendManagementReplayEnvelope(positionData, runtimeActions);
    } catch (error) {
      log("cron_error", `Management cycle failed: ${error.message}`);
      mgmtReport = `Management cycle failed: ${error.message}`;
      const failure = classifyRuntimeFailure(error);
      managementEvaluation = {
        cycle_id: cycleId,
        cycle_type: "management",
        status: "failed",
        summary: {
          positions_total: positions.length,
          reason_code: failure.reason_code,
          error: failure.message,
        },
        positions: [],
      };
      appendReplayEnvelope({
        cycle_id: cycleId,
        cycle_type: "management",
        reason_code: failure.reason_code,
        error: failure.message,
      });
      writeEvidenceBundle({
        cycle_id: cycleId,
        cycle_type: "management",
        status: "failed",
        reason_code: failure.reason_code,
        error: failure.message,
        written_at: new Date().toISOString(),
      });
    } finally {
      setManagementBusy(false);
      if (triggerFollowOnScreening) {
        runTriggeredScreening().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
			finalizeCycleRun({
				cycleType: "management",
				evaluation: managementEvaluation,
				recordCycleEvaluation,
				refreshRuntimeHealth,
				telegramEnabled,
				sendMessage,
				telegramPrefix: "🔄 Management Cycle",
				report: mgmtReport,
			});
		if (telegramEnabled()) {
			for (const p of positions) {
				if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
					notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
          }
        }
      }
    }
  };
}
