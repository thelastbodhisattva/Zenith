export function createScreeningCycleRunner(deps) {
  return async function runScreeningCycle({ cycleId } = {}) {
    const {
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
      recordCycleEvaluation,
      refreshRuntimeHealth,
      telegramEnabled,
      sendMessage,
      setScreeningBusy,
      setScreeningLastTriggered,
      setScreeningLastRun,
    } = deps;

    setScreeningBusy(true);
    setScreeningLastTriggered(Date.now());

    const failScreeningPrecheck = (failure) => {
      log("cron_error", `Screening pre-check failed: ${failure.message}`);
      recordCycleEvaluation({
        cycle_id: cycleId,
        cycle_type: "screening",
        status: "failed_precheck",
        summary: { reason_code: failure.reason_code, error: failure.message },
        candidates: [],
      });
      appendReplayEnvelope({
        cycle_id: cycleId,
        cycle_type: "screening",
        reason_code: failure.reason_code,
        error: failure.message,
      });
      writeEvidenceBundle({
        cycle_id: cycleId,
        cycle_type: "screening",
        status: "failed_precheck",
        reason_code: failure.reason_code,
        error: failure.message,
        written_at: new Date().toISOString(),
      });
    };

    let prePositions;
    let preBalance;
    let screenReport = null;
    let screeningEvaluation = null;
    let screeningTopCandidates = null;
    let candidateEvaluations = [];

    try {
      [prePositions, preBalance] = await Promise.all([getMyPositions(), getWalletBalances()]);
      const precheckFailure = validateStartupSnapshot({
        wallet: preBalance,
        positions: prePositions,
        candidates: { candidates: [] },
      });
      if (precheckFailure) {
        failScreeningPrecheck(precheckFailure);
        return;
      }

      const portfolioGuard = evaluatePortfolioGuard({
        portfolioSnapshot: preBalance,
      });
      const screeningAdmission = evaluateScreeningCycleAdmission({
        positionsCount: prePositions.total_positions,
        walletSol: preBalance.sol,
        config,
        portfolioGuard,
      });
      if (!screeningAdmission.allowed) {
        log("cron", screeningAdmission.log_message);
        recordCycleEvaluation({
          cycle_id: cycleId,
          cycle_type: "screening",
          status: screeningAdmission.status,
          summary: screeningAdmission.summary,
          candidates: [],
        });
        if (screeningAdmission.status === "skipped_guard_pause") {
          refreshRuntimeHealth({
            cycles: {
              screening: {
                status: screeningAdmission.status,
                reason: screeningAdmission.reason,
                at: new Date().toISOString(),
              },
            },
          });
        }
        return;
      }

      setScreeningLastRun(Date.now());
      log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

      const currentBalance = preBalance;
      const performanceSummary = getPerformanceSummary?.() || null;
      const discoverySnapshot = await discoverPools({
        page_size: 50,
        screeningConfig: config.screening,
      }).catch((error) => ({ pools: [], error: error.message }));
      const rawRegimeClassification = classifyRuntimeRegime({
        walletSol: currentBalance.sol,
        positionsCount: prePositions.total_positions,
        maxPositions: config.risk.maxPositions,
        deployFloor: config.management.deployAmountSol,
        gasReserve: config.management.gasReserve,
        performanceSummary,
        marketPools: discoverySnapshot?.pools || [],
      });
      const regimeClassification = applyRegimeHysteresis({
        classification: rawRegimeClassification,
      });
      const regimeContext = resolveRegimePackContext({
        baseScreeningConfig: config.screening,
        classification: regimeClassification,
      });
      const performanceMultiplier = getPerformanceSizingMultiplier(performanceSummary);
      const riskMultiplier = getRiskSizingMultiplier({
        positionsCount: prePositions.total_positions,
        maxPositions: config.risk.maxPositions,
      });
      const deployAmount = computeDeployAmount(currentBalance.sol, {
        regimeMultiplier: regimeContext.pack.deploy.regime_multiplier,
        performanceMultiplier,
        riskMultiplier,
        skipBelowFloor: true,
      });
      const activeStrategy = getActiveStrategy();
      const strategyKey = activeStrategy?.lp_strategy || "bid_ask";

      if (deployAmount <= 0) {
        log("cron", "Screening skipped - adaptive sizing returned 0 deploy amount");
        screeningEvaluation = {
          cycle_id: cycleId,
          cycle_type: "screening",
          status: "skipped_sizing_floor",
          summary: {
            regime: regimeContext.regime,
            reason_code: "adaptive_sizing_floor",
            wallet_sol: roundMetric(currentBalance.sol),
            reserve_sol: roundMetric(config.management.gasReserve),
            deploy_floor_sol: roundMetric(config.management.deployAmountSol),
          },
          candidates: [],
        };
        return;
      }

      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} - LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED - never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
        : "No active strategy - use default bid_ask, bins_above: 0, SOL only.";

      const buildCooldownPolicy = (regimeLabel) => (pool) => {
        const cooldown = getNegativeRegimeCooldown({
          pool_address: pool.pool,
          regime_label: regimeLabel,
          strategy: strategyKey,
        });
        if (!cooldown.active) return null;
        return {
          blocked: true,
          reason: "negative_regime_cooldown",
          penalty_score: 100,
          details: {
            key: cooldown.key,
            cooldown_until: cooldown.cooldown_until,
            remaining_ms: cooldown.remaining_ms,
            hits: cooldown.hits,
          },
        };
      };

      screeningTopCandidates = await getTopCandidates({
        limit: 8,
        pools: discoverySnapshot?.pools,
        screeningConfig: regimeContext.effectiveScreeningConfig,
        evaluationContext: {
          extraHardBlockFn: (pool) => {
            const globalCooldown = getNegativeRegimeMemory({
              regime_label: regimeContext.regime,
              strategy: strategyKey,
            });
            if (globalCooldown.active) {
              return {
                blocked: true,
                reason: "negative_regime_memory_cooldown",
                penalty_score: 100,
                details: {
                  key: globalCooldown.key,
                  cooldown_until: globalCooldown.cooldown_until,
                  remaining_ms: globalCooldown.remaining_ms,
                  hits: globalCooldown.hits,
                  sample_quality: globalCooldown.sample_quality,
                  cumulative_negative_pnl_abs: globalCooldown.cumulative_negative_pnl_abs,
                },
              };
            }
            return buildCooldownPolicy(regimeContext.regime)(pool);
          },
        },
      }).catch((error) => ({ error: error.message }));
      const screeningFailure = validateStartupSnapshot({
        wallet: { sol: preBalance.sol },
        positions: prePositions,
        candidates: screeningTopCandidates,
      });
      if (screeningFailure) {
        screeningEvaluation = {
          cycle_id: cycleId,
          cycle_type: "screening",
          status: "failed_candidates",
          summary: {
            reason_code: screeningFailure.reason_code,
            error: screeningFailure.message,
          },
          candidates: [],
        };
        appendReplayEnvelope({
          cycle_id: cycleId,
          cycle_type: "screening",
          reason_code: screeningFailure.reason_code,
          error: screeningFailure.message,
        });
        writeEvidenceBundle({
          cycle_id: cycleId,
          cycle_type: "screening",
          status: "failed_candidates",
          reason_code: screeningFailure.reason_code,
          error: screeningFailure.message,
          written_at: new Date().toISOString(),
        });
        screenReport = `Screening failed closed: [${screeningFailure.reason_code}] ${screeningFailure.message}`;
        return;
      }

      const candidates = screeningTopCandidates?.candidates || screeningTopCandidates?.pools || [];
      const totalEligible = screeningTopCandidates?.total_eligible ?? candidates.length;
      const blockedSummary = screeningTopCandidates?.blocked_summary || {};
      const shortlist = candidates.slice(0, Math.min(5, candidates.length));
      const finalists = shortlist.slice(0, Math.min(2, shortlist.length));
      const scorePreloadLimit = finalists.length;

      if (shortlist.length === 0) {
        log("cron", "Screening skipped - no eligible candidates after deterministic filters");
        screenReport = "Screening skipped - no eligible candidates passed deterministic filters.";
        screeningEvaluation = {
          cycle_id: cycleId,
          cycle_type: "screening",
          status: "skipped_no_candidates",
          summary: {
            total_screened: screeningTopCandidates?.total_screened ?? 0,
            total_eligible: totalEligible,
            blocked_summary: blockedSummary,
          },
          candidates: [],
        };
        return;
      }

      candidateEvaluations = shortlist.map((pool) => ({
        pool: pool.pool,
        name: pool.name,
        ranking_score: roundMetric(pool.deterministic_score),
        context_score: roundMetric(pool.deterministic_score),
        hard_blocked: false,
        hard_blocks: [],
        smart_wallet_count: 0,
        holder_metrics: null,
        wallet_score_source: finalists.some((candidate) => candidate.pool === pool.pool) ? "finalist_preload" : "not_loaded",
        wallet_score_age_minutes: null,
      }));

      const finalistBlocks = [];
      for (const pool of finalists) {
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
        const [inspection, distributionPlan, tierPlan] = await Promise.all([
          inspectCandidate(pool, executeTool),
          executeTool("choose_distribution_strategy", {
            pool_data: planningPoolData,
            expected_volume_profile: expectedVolumeProfile,
          }),
          executeTool("calculate_dynamic_bin_tiers", {
            six_hour_volatility: planningPoolData.six_hour_volatility,
            trend_bias: deriveTrendBias(pool, null),
          }),
        ]);

        const scoredLpers = inspection.scoredLpers || {
          message: "wallet score unavailable",
          candidates: [],
        };
        const candidateIntel = evaluateCandidateIntel(pool, {
          smartWallets: inspection.smartWallets,
          holders: inspection.holders,
          narrative: inspection.narrative,
          scoredLpers,
        });

        const evalEntry = candidateEvaluations.find((entry) => entry.pool === pool.pool);
        if (evalEntry) {
          evalEntry.context_score = candidateIntel.score.context_score;
          evalEntry.hard_blocked = candidateIntel.hard_blocked;
          evalEntry.hard_blocks = candidateIntel.hard_blocks;
          evalEntry.smart_wallet_count = candidateIntel.smart_wallet_count;
          evalEntry.holder_metrics = candidateIntel.holder_metrics;
          evalEntry.wallet_score_source = candidateIntel.wallet_score_source;
          evalEntry.wallet_score_age_minutes = candidateIntel.wallet_score_age_minutes;
        }

        finalistBlocks.push(formatFinalistInspectionBlock({
          pool,
          inspection,
          distributionPlan,
          tierPlan,
          candidateIntel,
        }));
      }

      const candidateContext = buildCandidateContext({ shortlist, finalists, inspectionRows: finalistBlocks });

      try {
        const activeTop = shortlist[0] || null;
        const alternates = [];
        for (const altRegime of listCounterfactualRegimes(regimeContext.regime)) {
          const altPack = getRegimePack(altRegime);
          const altDeployAmount = computeDeployAmount(currentBalance.sol, {
            regimeMultiplier: altPack.deploy.regime_multiplier,
            performanceMultiplier,
            riskMultiplier,
            skipBelowFloor: true,
          });
          const altCandidates = await getTopCandidates({
            limit: 3,
            pools: discoverySnapshot?.pools,
            screeningConfig: {
              ...config.screening,
              ...altPack.screening_overrides,
            },
            evaluationContext: {
              extraHardBlockFn: (pool) => {
                const globalCooldown = getNegativeRegimeMemory({
                  regime_label: altRegime,
                  strategy: strategyKey,
                });
                if (globalCooldown.active) {
                  return {
                    blocked: true,
                    reason: "negative_regime_memory_cooldown",
                    penalty_score: 100,
                    details: {
                      key: globalCooldown.key,
                      cooldown_until: globalCooldown.cooldown_until,
                      remaining_ms: globalCooldown.remaining_ms,
                      hits: globalCooldown.hits,
                      sample_quality: globalCooldown.sample_quality,
                      cumulative_negative_pnl_abs: globalCooldown.cumulative_negative_pnl_abs,
                    },
                  };
                }
                return buildCooldownPolicy(altRegime)(pool);
              },
            },
          }).catch(() => ({ candidates: [] }));
          const altTop = (altCandidates?.candidates || [])[0] || null;
          alternates.push({
            regime: altRegime,
            deploy_amount_sol: altDeployAmount,
            selected_pool: altTop?.pool || null,
            selected_score: altTop?.deterministic_score ?? null,
            diverged_from_active: Boolean(activeTop && altTop && activeTop.pool !== altTop.pool),
          });
        }

        appendCounterfactualReview({
          cycle_id: cycleId,
          cycle_type: "screening",
          active_regime: regimeContext.regime,
          active_reason: regimeContext.reason,
          active_deploy_amount_sol: deployAmount,
          active_selected_pool: activeTop?.pool || null,
          active_selected_score: activeTop?.deterministic_score ?? null,
          alternates,
        });
      } catch (counterfactualError) {
        log("screening", `Counterfactual review skipped: ${counterfactualError.message}`);
      }

      const { content } = await agentLoop(`
SCREENING CYCLE - DEPLOY ONLY
${strategyBlock}
Regime: ${regimeContext.regime} (${regimeContext.reason}) | Sizing multipliers: regime=${regimeContext.pack.deploy.regime_multiplier} perf=${performanceMultiplier} risk=${riskMultiplier}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${candidateContext}
DECISION RULES (apply to the pre-loaded candidates above, no re-fetching needed):
- Respect hard_gate=BLOCKED. Never deploy a blocked candidate.
- Ranking precedence: use ranking_score first. context_score is explanatory context only; it must not override a blocked candidate.
- Only the top ${finalists.length} finalist candidate${finalists.length === 1 ? "" : "s"} were enriched with heavy signals.

STEPS:
1. Pick the best candidate from the pre-loaded analysis above. If none pass, report why and stop.
2. Reuse the pre-loaded LP-wallet scoring and planner context in your reasoning.
3. deploy_position directly.
4. Report: pool chosen, key signals, LP-wallet score takeaway, planner takeaway, deploy outcome.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 4096, {
        toolContext: {
          cycle_id: cycleId,
          cycle_type: "screening",
          regime_label: regimeContext.regime,
        },
      });

      screenReport = content;
      screeningEvaluation = {
        cycle_id: cycleId,
        cycle_type: "screening",
        status: "completed",
        summary: {
          total_screened: screeningTopCandidates?.total_screened ?? candidates.length,
          total_eligible: totalEligible,
            candidates_scored: candidateEvaluations.length,
            candidates_blocked: candidateEvaluations.filter((candidate) => candidate.hard_blocked).length,
            deploy_amount: deployAmount,
            regime: regimeContext.regime,
            regime_reason: regimeContext.reason,
            regime_confidence: regimeContext.confidence,
            regime_hysteresis_reason: regimeClassification.hysteresis_reason,
            proposed_regime: regimeClassification.proposed_regime,
            regime_multiplier: regimeContext.pack.deploy.regime_multiplier,
            performance_multiplier: performanceMultiplier,
            risk_multiplier: riskMultiplier,
            score_preload_limit: scorePreloadLimit,
            blocked_summary: blockedSummary,
          },
        candidates: candidateEvaluations,
      };
      appendReplayEnvelope({
        cycle_id: cycleId,
        cycle_type: "screening",
        occupied_pools: screeningTopCandidates?.occupied_pools || [],
        occupied_mints: screeningTopCandidates?.occupied_mints || [],
        candidate_inputs: screeningTopCandidates?.candidate_inputs || [],
        shortlist: shortlist.map((pool) => ({
          pool: pool.pool,
          name: pool.name,
          ranking_score: pool.deterministic_score,
        })),
        total_eligible: totalEligible,
      });
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
      const failure = classifyRuntimeFailure(error);
      screeningEvaluation = {
        cycle_id: cycleId,
        cycle_type: "screening",
        status: "failed",
        summary: {
          reason_code: failure.reason_code,
          error: failure.message,
          total_eligible: screeningTopCandidates?.total_eligible ?? 0,
        },
        candidates: [],
      };
      appendReplayEnvelope({
        cycle_id: cycleId,
        cycle_type: "screening",
        reason_code: failure.reason_code,
        error: failure.message,
      });
      writeEvidenceBundle({
        cycle_id: cycleId,
        cycle_type: "screening",
        status: "failed",
        reason_code: failure.reason_code,
        error: failure.message,
        written_at: new Date().toISOString(),
      });
    } finally {
      if (screeningEvaluation) recordCycleEvaluation(screeningEvaluation);
      setScreeningBusy(false);
      refreshRuntimeHealth({
        cycles: {
          screening: {
            status: screeningEvaluation?.status || "completed",
            reason: screeningEvaluation?.summary?.reason_code || null,
            at: new Date().toISOString(),
          },
        },
      });
      if (telegramEnabled() && screenReport) {
        sendMessage(`🔍 Screening Cycle\n\n${screenReport}`).catch(() => {});
      }
    }
  };
}
