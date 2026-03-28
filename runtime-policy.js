function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMetric(value) {
  return Number(Number(value || 0).toFixed(2));
}

export const MANAGEMENT_SUBREASONS = Object.freeze({
  INSTRUCTION: "instruction_condition_met",
  EXIT_ALERT: "exit_alert",
  STOP_LOSS: "stop_loss_pct_breached",
  TAKE_PROFIT: "take_profit_pct_reached",
  OUT_OF_RANGE: "out_of_range_rebalance",
  LOW_FEE_YIELD: "fee_yield_below_floor",
  FEE_THRESHOLD: "fee_threshold_reached",
});

export const DEPLOY_GOVERNANCE_CODES = Object.freeze({
  PORTFOLIO_GUARD_ACTIVE: "portfolio_guard_active",
  POOL_LOW_YIELD_COOLDOWN_ACTIVE: "pool_low_yield_cooldown_active",
  INVALID_BIN_STEP: "invalid_bin_step",
  MAX_POSITIONS_REACHED: "max_positions_reached",
  POOL_ALREADY_OPEN: "pool_already_open",
  BASE_TOKEN_ALREADY_HELD: "base_token_already_held",
  MISSING_DEPLOY_AMOUNT: "missing_deploy_amount",
  BELOW_MIN_DEPLOY: "below_min_deploy",
  ABOVE_MAX_DEPLOY: "above_max_deploy",
  INSUFFICIENT_SOL: "insufficient_sol",
});

export const SCREENING_ADMISSION_STATUSES = Object.freeze({
  READY: "ready",
  SKIPPED_MAX_POSITIONS: "skipped_max_positions",
  SKIPPED_INSUFFICIENT_BALANCE: "skipped_insufficient_balance",
  SKIPPED_GUARD_PAUSE: "skipped_guard_pause",
});

function normalizeInstructionText(instruction) {
  return String(instruction || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseInstructionThreshold(instruction) {
  const normalized = normalizeInstructionText(instruction);
  if (!normalized) return null;

  const comparatorMatch = normalized.match(/(?:pnl|profit|gain|loss)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)%/i);
  if (comparatorMatch) {
    return {
      comparator: comparatorMatch[1],
      thresholdPct: Number(comparatorMatch[2]),
      source: "explicit_comparator",
    };
  }

  const closeAtProfit = normalized.match(/(?:close|sell|take profit|hold)\s+(?:at|until|when)\s*(-?\d+(?:\.\d+)?)%\s+profit/i);
  if (closeAtProfit) {
    return {
      comparator: ">=",
      thresholdPct: Number(closeAtProfit[1]),
      source: "profit_phrase",
    };
  }

  const stopLoss = normalized.match(/(?:stop loss|close|sell|hold)\s+(?:at|until|when)\s*(-?\d+(?:\.\d+)?)%\s+loss/i);
  if (stopLoss) {
    const raw = Number(stopLoss[1]);
    return {
      comparator: "<=",
      thresholdPct: raw > 0 ? -raw : raw,
      source: "loss_phrase",
    };
  }

  return null;
}

function compareThreshold(currentPct, comparator, thresholdPct) {
  switch (comparator) {
    case ">=": return currentPct >= thresholdPct;
    case ">": return currentPct > thresholdPct;
    case "<=": return currentPct <= thresholdPct;
    case "<": return currentPct < thresholdPct;
    default: return false;
  }
}

export function classifyInstructionRuntimeGate(position = {}) {
  if (!position.instruction) {
    return {
      route: "runtime",
      reason: "no_instruction",
      action: "runtime_policy",
    };
  }

  const parsed = parseInstructionThreshold(position.instruction);
  if (!parsed) {
    return {
      route: "model",
      reason: "instruction_requires_model",
      action: "model_evaluation",
    };
  }

  const pnlSignalStale = isPnlSignalStale(position);
  const pnlPct = !pnlSignalStale && Number.isFinite(Number(position.pnl?.pnl_pct ?? position.pnl_pct))
    ? Number(position.pnl?.pnl_pct ?? position.pnl_pct)
    : null;

  if (pnlPct == null) {
    return {
      route: "runtime",
      reason: "instruction_waiting_for_fresh_pnl",
      action: "hold",
      parsed,
    };
  }

  const met = compareThreshold(pnlPct, parsed.comparator, parsed.thresholdPct);
  return {
    route: "runtime",
    reason: met ? "instruction_condition_met" : "instruction_condition_not_met",
    action: met ? "close" : "hold",
    parsed,
    pnlPct,
  };
}

export function deriveExpectedVolumeProfile(snapshot = {}) {
  const feeTvlRatio = asNumber(snapshot.fee_active_tvl_ratio ?? snapshot.fee_tvl_ratio, 0);
  const volume = asNumber(snapshot.volume_window ?? snapshot.volume_24h, 0);
  const volatility = asNumber(snapshot.six_hour_volatility ?? snapshot.volatility, 0);

  if (volatility >= 18 || volume >= 250_000 || feeTvlRatio >= 1.5) return "bursty";
  if (volatility >= 10 || volume >= 75_000 || feeTvlRatio >= 0.5) return "high";
  if (volume >= 10_000 || feeTvlRatio >= 0.12) return "balanced";
  return "low";
}

export function resolveTargetManagementInterval(positions = []) {
  const maxVolatility = positions.reduce((max, position) => {
    const candidate = Number(position?.volatility ?? 0);
    return Number.isFinite(candidate) ? Math.max(max, candidate) : max;
  }, 0);

  const interval = maxVolatility >= 5 ? 3 : maxVolatility >= 2 ? 5 : 10;
  return { interval, maxVolatility: roundMetric(maxVolatility) };
}

export function isPnlSignalStale(position = {}) {
  const pnl = position?.pnl;
  if (!pnl || typeof pnl !== "object") return false;
  if (pnl.stale === true || pnl.lagging === true || pnl.status === "stale") return true;

  const observedAtMs = Number.isFinite(Number(pnl.observed_at_ms ?? pnl.as_of_ms))
    ? Number(pnl.observed_at_ms ?? pnl.as_of_ms)
    : Number.isFinite(Date.parse(pnl.observed_at ?? pnl.as_of ?? ""))
      ? Date.parse(pnl.observed_at ?? pnl.as_of)
      : null;
  const maxAgeMs = Number(pnl.max_age_ms ?? position.max_pnl_age_ms);

  if (observedAtMs == null || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return false;
  }

  return Date.now() - observedAtMs > maxAgeMs;
}

export function evaluateTrackedPositionExit({
  positionState = {},
  currentPnlPct,
  managementConfig = {},
  stale = false,
} = {}) {
  const normalizedPnlPct = Number(currentPnlPct);
  const currentPeak = Number(positionState?.peak_pnl_pct ?? 0);
  let peakPnlPct = Number.isFinite(currentPeak) ? currentPeak : 0;
  let trailingActive = Boolean(positionState?.trailing_active);

  if (stale || !Number.isFinite(normalizedPnlPct)) {
    return {
      action: null,
      peak_pnl_pct: peakPnlPct,
      trailing_active: trailingActive,
      notes: [],
      log_message: null,
    };
  }

  if (managementConfig.stopLossPct != null && normalizedPnlPct <= managementConfig.stopLossPct) {
    const action = `STOP_LOSS: PnL ${normalizedPnlPct.toFixed(1)}% hit stop loss (${managementConfig.stopLossPct}%)`;
    return {
      action,
      peak_pnl_pct: peakPnlPct,
      trailing_active: trailingActive,
      notes: [action],
      log_message: null,
    };
  }

  if (normalizedPnlPct > peakPnlPct) {
    peakPnlPct = normalizedPnlPct;
  }

  const notes = [];
  let logMessage = null;
  if (managementConfig.trailingTakeProfit) {
    if (!trailingActive && normalizedPnlPct >= managementConfig.trailingTriggerPct) {
      trailingActive = true;
      notes.push(`Trailing TP activated at ${normalizedPnlPct.toFixed(1)}%`);
      logMessage = `trailing TP activated (peak: ${normalizedPnlPct.toFixed(1)}%)`;
    }

    if (trailingActive) {
      const dropFromPeak = peakPnlPct - normalizedPnlPct;
      if (dropFromPeak >= managementConfig.trailingDropPct) {
        const action = `TRAILING_TP: PnL dropped ${dropFromPeak.toFixed(1)}% from peak ${peakPnlPct.toFixed(1)}% (trail: ${managementConfig.trailingDropPct}%)`;
        notes.push(action);
        return {
          action,
          peak_pnl_pct: peakPnlPct,
          trailing_active: trailingActive,
          notes,
          log_message: logMessage,
        };
      }
    }
  }

  return {
    action: null,
    peak_pnl_pct: peakPnlPct,
    trailing_active: trailingActive,
    notes,
    log_message: logMessage,
  };
}

export function evaluateScreeningCycleAdmission({
  positionsCount = 0,
  walletSol = 0,
  config,
  portfolioGuard = null,
} = {}) {
  if (positionsCount >= config.risk.maxPositions) {
    return {
      allowed: false,
      status: SCREENING_ADMISSION_STATUSES.SKIPPED_MAX_POSITIONS,
      log_message: `Screening skipped - max positions reached (${positionsCount}/${config.risk.maxPositions})`,
      summary: {
        total_positions: positionsCount,
        max_positions: config.risk.maxPositions,
      },
    };
  }

  const minRequired = config.management.deployAmountSol + config.management.gasReserve;
  if (walletSol < minRequired) {
    return {
      allowed: false,
      status: SCREENING_ADMISSION_STATUSES.SKIPPED_INSUFFICIENT_BALANCE,
      log_message: `Screening skipped - insufficient SOL (${walletSol.toFixed(3)} < ${minRequired} needed for deploy + gas)`,
      summary: {
        wallet_sol: roundMetric(walletSol),
        min_required_sol: roundMetric(minRequired),
      },
    };
  }

  if (portfolioGuard?.blocked) {
    return {
      allowed: false,
      status: SCREENING_ADMISSION_STATUSES.SKIPPED_GUARD_PAUSE,
      log_message: `Screening paused by portfolio guard: ${portfolioGuard.reason}`,
      summary: {
        reason_code: portfolioGuard.reason_code,
        reason: portfolioGuard.reason,
        pause_until: portfolioGuard.pause_until,
      },
      reason: portfolioGuard.reason,
    };
  }

  return {
    allowed: true,
    status: SCREENING_ADMISSION_STATUSES.READY,
    summary: {},
  };
}

function toSet(values) {
  if (values instanceof Set) return values;
  if (Array.isArray(values)) return new Set(values.filter(Boolean));
  return new Set();
}

export function evaluateExposureAdmission({
  poolAddress = null,
  baseMint = null,
  occupiedPools = new Set(),
  occupiedMints = new Set(),
} = {}) {
  const poolSet = toSet(occupiedPools);
  const mintSet = toSet(occupiedMints);
  const hardBlocks = [];
  let code = null;
  let message = null;

  if (poolAddress && poolSet.has(poolAddress)) {
    hardBlocks.push("pool_already_open");
    code ||= DEPLOY_GOVERNANCE_CODES.POOL_ALREADY_OPEN;
    message ||= `Already have an open position in pool ${poolAddress}. Cannot open duplicate.`;
  }

  if (baseMint && mintSet.has(baseMint)) {
    hardBlocks.push("base_token_already_held");
    code ||= DEPLOY_GOVERNANCE_CODES.BASE_TOKEN_ALREADY_HELD;
    message ||= `Already holding base token ${baseMint} in another pool. One position per token only.`;
  }

  return {
    pass: hardBlocks.length === 0,
    code,
    hard_block: hardBlocks[0] || null,
    hard_blocks: hardBlocks,
    message,
  };
}

export function evaluateDeployAdmission({
  config,
  poolAddress = null,
  baseMint = null,
  amountY = 0,
  amountX = 0,
  binStep = null,
  positions = [],
  positionsCount = null,
  walletSol = null,
  portfolioGuard = null,
  poolCooldown = null,
  enforcePositionLimit = true,
  enforceExposure = true,
  enforceBinStep = true,
  enforceSize = true,
  enforceBalance = true,
} = {}) {
  if (portfolioGuard?.blocked) {
    return {
      pass: false,
      code: DEPLOY_GOVERNANCE_CODES.PORTFOLIO_GUARD_ACTIVE,
      message: `Portfolio guard active: ${portfolioGuard.reason}`,
      details: {
        pause_until: portfolioGuard.pause_until,
        reason_code: portfolioGuard.reason_code,
        reason: portfolioGuard.reason,
      },
    };
  }

  if (poolCooldown?.active) {
    return {
      pass: false,
      code: DEPLOY_GOVERNANCE_CODES.POOL_LOW_YIELD_COOLDOWN_ACTIVE,
      message: `Pool ${poolAddress} is in low-yield cooldown until ${poolCooldown.cooldown_until}.`,
      details: {
        cooldown_until: poolCooldown.cooldown_until,
        remaining_ms: poolCooldown.remaining_ms,
        reason: poolCooldown.reason,
      },
    };
  }

  if (enforceBinStep && binStep != null) {
    const minStep = config.screening.minBinStep;
    const maxStep = config.screening.maxBinStep;
    if (binStep < minStep || binStep > maxStep) {
      return {
        pass: false,
        code: DEPLOY_GOVERNANCE_CODES.INVALID_BIN_STEP,
        message: `bin_step ${binStep} is outside the allowed range of [${minStep}-${maxStep}].`,
      };
    }
  }

  const openPositions = Array.isArray(positions) ? positions : [];
  const effectivePositionsCount = Number.isFinite(Number(positionsCount))
    ? Number(positionsCount)
    : openPositions.length;

  if (enforcePositionLimit && effectivePositionsCount >= config.risk.maxPositions) {
    return {
      pass: false,
      code: DEPLOY_GOVERNANCE_CODES.MAX_POSITIONS_REACHED,
      message: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
    };
  }

  if (enforceExposure) {
    const exposure = evaluateExposureAdmission({
      poolAddress,
      baseMint,
      occupiedPools: openPositions.map((position) => position?.pool),
      occupiedMints: openPositions.map((position) => position?.base_mint),
    });
    if (!exposure.pass) {
      return exposure;
    }
  }

  if (enforceSize) {
    if (amountY <= 0 && (!amountX || amountX <= 0)) {
      return {
        pass: false,
        code: DEPLOY_GOVERNANCE_CODES.MISSING_DEPLOY_AMOUNT,
        message: "Must provide a positive amount for either SOL (amount_y) or base token (amount_x).",
      };
    }

    const minDeploy = Math.max(0.1, config.management.deployAmountSol);
    if (amountY < minDeploy) {
      return {
        pass: false,
        code: DEPLOY_GOVERNANCE_CODES.BELOW_MIN_DEPLOY,
        message: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
      };
    }

    if (amountY > config.risk.maxDeployAmount) {
      return {
        pass: false,
        code: DEPLOY_GOVERNANCE_CODES.ABOVE_MAX_DEPLOY,
        message: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
      };
    }
  }

  if (enforceBalance && walletSol != null) {
    const gasReserve = config.management.gasReserve;
    const minRequired = amountY + gasReserve;
    if (walletSol < minRequired) {
      return {
        pass: false,
        code: DEPLOY_GOVERNANCE_CODES.INSUFFICIENT_SOL,
        message: `Insufficient SOL: have ${walletSol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
      };
    }
  }

  return {
    pass: true,
    code: null,
    message: null,
    details: null,
  };
}

export function planManagementRuntimeAction(position, config, expectedVolumeProfile = null, { phase = "all" } = {}) {
  const instructionGate = classifyInstructionRuntimeGate(position);
  if (instructionGate.action === "close") {
    return {
      toolName: "close_position",
      args: { position_address: position.position, reason: position.instruction },
      reason: `instruction met (${instructionGate.parsed.comparator} ${instructionGate.parsed.thresholdPct}%, current ${instructionGate.pnlPct.toFixed(2)}%)`,
      rule: MANAGEMENT_SUBREASONS.INSTRUCTION,
    };
  }
  if (position.instruction) return null;

  const pnlSignalStale = isPnlSignalStale(position);

  const pnlPct = !pnlSignalStale && Number.isFinite(Number(position.pnl?.pnl_pct ?? position.pnl_pct))
    ? Number(position.pnl?.pnl_pct ?? position.pnl_pct)
    : null;
  const feePerTvl24h = !pnlSignalStale && Number.isFinite(Number(position.pnl?.fee_per_tvl_24h ?? position.fee_per_tvl_24h))
    ? Number(position.pnl?.fee_per_tvl_24h ?? position.fee_per_tvl_24h)
    : null;
	const feesUsd = pnlSignalStale
		? 0
		: asNumber(position.pnl?.unclaimed_fee_usd ?? position.unclaimed_fees_usd, 0);
	const totalFeesEarnedUsd = pnlSignalStale
		? 0
		: feesUsd + asNumber(position.collected_fees_usd, 0);
	const initialValueUsd = asNumber(position.initial_value_usd, 0);
	const feeTakeProfitPct = initialValueUsd > 0
		? (totalFeesEarnedUsd / initialValueUsd) * 100
		: null;
	const oorMinutes = asNumber(position.minutes_out_of_range, 0);
	const derivedVolumeProfile = expectedVolumeProfile || deriveExpectedVolumeProfile({
    fee_tvl_ratio: position.fee_tvl_ratio,
    volatility: position.pnl?.volatility ?? position.volatility,
    volume_window: position.volume_window,
  });

  if (position.exitAlert && !pnlSignalStale) {
    return {
      toolName: "close_position",
      args: { position_address: position.position, reason: position.exitAlert },
      reason: position.exitAlert,
      rule: MANAGEMENT_SUBREASONS.EXIT_ALERT,
    };
  }

  if (pnlPct != null && pnlPct <= config.management.emergencyPriceDropPct) {
    return {
      toolName: "close_position",
      args: { position_address: position.position, reason: "emergency stop loss" },
      reason: `pnl ${pnlPct.toFixed(2)}% <= ${config.management.emergencyPriceDropPct}%`,
      rule: MANAGEMENT_SUBREASONS.STOP_LOSS,
    };
  }

	if (feeTakeProfitPct != null && feeTakeProfitPct >= config.management.takeProfitFeePct) {
		return {
			toolName: "close_position",
			args: { position_address: position.position, reason: "fixed take profit" },
			reason: `fees ${feeTakeProfitPct.toFixed(2)}% >= ${config.management.takeProfitFeePct}% of deployed capital`,
			rule: MANAGEMENT_SUBREASONS.TAKE_PROFIT,
		};
	}

  if (position.in_range === false) {
    return {
      toolName: "rebalance_on_exit",
      args: {
        position_address: position.position,
        execute: true,
        expected_volume_profile: derivedVolumeProfile,
      },
      reason: oorMinutes > 0 ? `out of range for ${oorMinutes}m` : "out of range",
      rule: MANAGEMENT_SUBREASONS.OUT_OF_RANGE,
    };
  }

	if (phase === "fast") {
		return null;
	}

  if (feePerTvl24h != null && feePerTvl24h < config.management.minFeePerTvl24h && asNumber(position.age_minutes, 0) >= 60) {
    return {
      toolName: "close_position",
      args: { position_address: position.position, reason: "fee yield too low" },
      reason: `fee_per_tvl_24h ${feePerTvl24h.toFixed(2)} < ${config.management.minFeePerTvl24h}`,
      rule: MANAGEMENT_SUBREASONS.LOW_FEE_YIELD,
    };
  }

  if (feesUsd >= config.management.minClaimAmount) {
    return {
      toolName: "auto_compound_fees",
      args: {
        position_address: position.position,
        execute_reinvest: false,
        expected_volume_profile: derivedVolumeProfile,
      },
      reason: `fees $${feesUsd.toFixed(2)} >= $${config.management.minClaimAmount}`,
      rule: MANAGEMENT_SUBREASONS.FEE_THRESHOLD,
    };
  }

  return null;
}

export function classifyManagementModelGate(position = {}) {
  const instructionGate = classifyInstructionRuntimeGate(position);
  if (instructionGate.route === "model") {
    return {
      route: "model",
      reason: instructionGate.reason,
    };
  }

  return {
    route: "runtime",
    reason: instructionGate.reason,
  };
}
