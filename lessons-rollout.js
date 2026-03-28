import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";
import { writeEvidenceBundle } from "./evidence-bundles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP = 0.2;
const MIN_ROLLOUT_CLOSES = 5;
const ROLLOUT_MAX_HISTORY = 25;

function getUserConfigPath() {
	return (
		process.env.ZENITH_USER_CONFIG_PATH ||
		path.join(__dirname, "user-config.json")
	);
}

function getLessonsFile() {
	return process.env.ZENITH_LESSONS_FILE || "./lessons.json";
}

function getThresholdRolloutFile() {
	return (
		process.env.ZENITH_THRESHOLD_ROLLOUT_FILE || "./threshold-rollout.json"
	);
}

function writeEvolutionEvidence({
	status,
	reason_code,
	rollout_id = null,
	old_values = null,
	new_values = null,
	metrics = null,
	rollback_reason = null,
	trigger = "auto",
}) {
	const evidenceId = rollout_id || `evolution-${Date.now()}`;
	writeEvidenceBundle({
		cycle_id: `evolution:${evidenceId}`,
		incident_key: rollout_id || evidenceId,
		cycle_type: "threshold_evolution",
		status,
		reason_code,
		runbook_slug: "runbook-threshold-evolution",
		trigger,
		rollout_id,
		old_values,
		new_values,
		metrics,
		rollback_reason,
		written_at: new Date().toISOString(),
	});
}

function invalidState(reason_code, error, trigger = "auto") {
	writeEvolutionEvidence({
		status: "blocked_invalid_state",
		reason_code,
		metrics: { error },
		trigger,
	});
	return {
		changes: {},
		rationale: {},
		rollout: {
			status: "blocked_invalid_state",
			reason_code,
			error,
		},
		requires_reload: false,
	};
}

function loadLessonsData() {
	const snapshot = readJsonSnapshotWithBackupSync(getLessonsFile());
	if (!snapshot.value) {
		if (!snapshot.error) return { lessons: [], performance: [] };
		return { lessons: [], performance: [], invalid_state: true, error: snapshot.error };
	}
	return {
		lessons: Array.isArray(snapshot.value.lessons) ? snapshot.value.lessons : [],
		performance: Array.isArray(snapshot.value.performance) ? snapshot.value.performance : [],
		loaded_from_backup: snapshot.source === "backup",
	};
}

function appendEvolutionLesson(data, rule, tags) {
	data.lessons.push({
		id: Date.now(),
		rule,
		tags,
		outcome: "manual",
		created_at: new Date().toISOString(),
	});
}

function saveLessonsData(data) {
	writeJsonSnapshotAtomicSync(getLessonsFile(), data);
}

function loadThresholdRolloutState() {
	const snapshot = readJsonSnapshotWithBackupSync(getThresholdRolloutFile());
	if (!snapshot.value) {
		if (!snapshot.error) return { active: null, history: [] };
		return { active: null, history: [], invalid_state: true, error: snapshot.error };
	}
	return {
		active: snapshot.value?.active || null,
		history: Array.isArray(snapshot.value?.history) ? snapshot.value.history : [],
		loaded_from_backup: snapshot.source === "backup",
	};
}

function saveThresholdRolloutState(state) {
	writeJsonSnapshotAtomicSync(getThresholdRolloutFile(), {
		active: state?.active || null,
		history: Array.isArray(state?.history)
			? state.history.slice(-ROLLOUT_MAX_HISTORY)
			: [],
	});
}

function getPerformanceSnapshot(perfRows) {
	if (!Array.isArray(perfRows) || perfRows.length === 0) {
		return { closes: 0, avg_pnl_pct: 0, win_rate_pct: 0 };
	}
	const closes = perfRows.length;
	const avgPnlPct =
		perfRows.reduce((sum, row) => sum + (Number(row.pnl_pct) || 0), 0) / closes;
	const wins = perfRows.filter((row) => (Number(row.pnl_pct) || 0) >= 0).length;
	return {
		closes,
		avg_pnl_pct: Number(avgPnlPct.toFixed(2)),
		win_rate_pct: Number(((wins / closes) * 100).toFixed(2)),
	};
}

function writeScreeningKeysToUserConfig(values) {
	const userConfigPath = getUserConfigPath();
	const snapshot = readJsonSnapshotWithBackupSync(userConfigPath);
	if (!snapshot.value && snapshot.error) {
		return { pass: false, error: snapshot.error };
	}
	const userConfig = snapshot.value || {};
	Object.assign(userConfig, values);
	userConfig._lastEvolved = new Date().toISOString();
	writeJsonSnapshotAtomicSync(userConfigPath, userConfig);
	return { pass: true };
}

function applyScreeningChangesToConfig(config, values) {
	const s = config.screening;
	if (values.minFeeActiveTvlRatio != null)
		s.minFeeActiveTvlRatio = values.minFeeActiveTvlRatio;
	if (values.minOrganic != null) s.minOrganic = values.minOrganic;
}

function revertScreeningChangesInConfig(config, previousValues = {}) {
	const s = config.screening;
	if (previousValues.minFeeActiveTvlRatio != null)
		s.minFeeActiveTvlRatio = previousValues.minFeeActiveTvlRatio;
	if (previousValues.minOrganic != null) s.minOrganic = previousValues.minOrganic;
}

function buildActiveRollout({
	phase = "active",
	rollout_id,
	started_at = new Date().toISOString(),
	start_positions_count,
	min_closes_required,
	changed_keys,
	previous_values,
	new_values,
	baseline,
	pending_decision = null,
}) {
	return {
		phase,
		rollout_id,
		started_at,
		start_positions_count,
		min_closes_required,
		changed_keys,
		previous_values,
		new_values,
		baseline,
		pending_decision,
	};
}

function finalizeHistoryEntry(active, decision) {
	return {
		rollout_id: active.rollout_id,
		started_at: active.started_at,
		start_positions_count: active.start_positions_count,
		min_closes_required: active.min_closes_required,
		changed_keys: active.changed_keys,
		previous_values: active.previous_values,
		new_values: active.new_values,
		baseline: active.baseline,
		...decision,
	};
}

export function recoverThresholdRolloutState(config, { trigger = "recovery" } = {}) {
	const rollout = loadThresholdRolloutState();
	if (rollout.invalid_state) {
		return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", rollout.error, trigger);
	}
	if (!rollout.active) {
		return { status: "clear" };
	}

	const active = rollout.active;
	if (active.phase === "apply_pending") {
		const configWrite = writeScreeningKeysToUserConfig({
			...(active.new_values || {}),
			_positionsAtEvolution: active.start_positions_count,
		});
		if (!configWrite.pass) {
			return invalidState("EVOLVE_CONFIG_STATE_INVALID", configWrite.error, trigger);
		}
		applyScreeningChangesToConfig(config, active.new_values || {});
		try {
			saveThresholdRolloutState({
				active: {
					...active,
					phase: "active",
				},
				history: rollout.history || [],
			});
		} catch (error) {
			return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", error.message, trigger);
		}
		return { status: "recovered_apply", rollout_id: active.rollout_id };
	}

	if (active.phase === "rollback_pending") {
		const rollbackWrite = writeScreeningKeysToUserConfig(active.previous_values || {});
		if (!rollbackWrite.pass) {
			return invalidState("EVOLVE_CONFIG_STATE_INVALID", rollbackWrite.error, trigger);
		}
		revertScreeningChangesInConfig(config, active.previous_values || {});
		const decision = active.pending_decision || {
			rollout_id: active.rollout_id,
			status: "rolled_back",
			changed_keys: active.changed_keys || [],
			baseline: active.baseline || getPerformanceSnapshot([]),
			post: getPerformanceSnapshot([]),
			closes_since_start: 0,
			rollback_reason: "recovered_pending_rollback",
		};
		try {
			saveThresholdRolloutState({
				active: null,
				history: [...(rollout.history || []), finalizeHistoryEntry(active, decision)],
			});
		} catch (error) {
			return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", error.message, trigger);
		}
		writeEvolutionEvidence({
			status: decision.status,
			reason_code: "EVOLVE_ROLLED_BACK",
			rollout_id: active.rollout_id,
			old_values: active.previous_values || null,
			new_values: active.new_values || null,
			metrics: {
				baseline: decision.baseline,
				post: decision.post,
				closes_since_start: decision.closes_since_start,
			},
			rollback_reason: decision.rollback_reason,
			trigger,
		});
		return { status: "recovered_rollback", rollout_id: active.rollout_id };
	}

	return { status: "clear" };
}

function evaluatePendingThresholdRollout(perfData, config, { trigger = "auto", lessonsData } = {}) {
	const rollout = loadThresholdRolloutState();
	if (rollout.invalid_state) {
		return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", rollout.error, trigger);
	}
	if (!rollout.active) return null;

	const active = rollout.active;
	const closesSinceStart = Math.max(
		0,
		perfData.length - (active.start_positions_count || 0),
	);
	const minClosesRequired =
		Number(active.min_closes_required) || MIN_ROLLOUT_CLOSES;

	if (closesSinceStart < minClosesRequired) {
		return {
			status: "pending",
			closes_since_start: closesSinceStart,
			min_closes_required: minClosesRequired,
			requires_reload: false,
		};
	}

	const postSlice = perfData.slice(active.start_positions_count);
	const post = getPerformanceSnapshot(postSlice);
	const baseline = active.baseline || getPerformanceSnapshot([]);
	const degradedAvgPnl = post.avg_pnl_pct < baseline.avg_pnl_pct - 1;
	const degradedWinRate = post.win_rate_pct < baseline.win_rate_pct - 10;
	const rollback = degradedAvgPnl || degradedWinRate;

	const decision = {
		rollout_id: active.rollout_id,
		evaluated_at: new Date().toISOString(),
		status: rollback ? "rolled_back" : "accepted",
		changed_keys: active.changed_keys || [],
		baseline,
		post,
		closes_since_start: closesSinceStart,
		rollback_reason: rollback
			? `${degradedAvgPnl ? "avg_pnl_degraded" : ""}${degradedAvgPnl && degradedWinRate ? "+" : ""}${degradedWinRate ? "win_rate_degraded" : ""}`
			: null,
	};

	if (rollback) {
		try {
			saveThresholdRolloutState({
				active: {
					...active,
					phase: "rollback_pending",
					pending_decision: decision,
				},
				history: rollout.history || [],
			});
		} catch (error) {
			return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", error.message, trigger);
		}
		const rollbackWrite = writeScreeningKeysToUserConfig(active.previous_values || {});
		if (!rollbackWrite.pass) {
			return invalidState("EVOLVE_CONFIG_STATE_INVALID", rollbackWrite.error, trigger);
		}
		revertScreeningChangesInConfig(config, active.previous_values || {});
	}

	try {
		saveThresholdRolloutState({
			active: null,
			history: [...(rollout.history || []), finalizeHistoryEntry(active, decision)],
		});
	} catch (error) {
		return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", error.message, trigger);
	}

	writeEvolutionEvidence({
		status: decision.status,
		reason_code: rollback ? "EVOLVE_ROLLED_BACK" : "EVOLVE_ACCEPTED",
		rollout_id: active.rollout_id,
		old_values: active.previous_values || null,
		new_values: active.new_values || null,
		metrics: {
			baseline,
			post,
			closes_since_start: closesSinceStart,
		},
		rollback_reason: decision.rollback_reason,
		trigger,
	});
	if (lessonsData) {
		try {
			appendEvolutionLesson(
				lessonsData,
				`[AUTO-EVOLUTION ${decision.status.toUpperCase()}] ${decision.changed_keys.join(", ")} | baseline avg=${baseline.avg_pnl_pct}% win=${baseline.win_rate_pct}% -> post avg=${post.avg_pnl_pct}% win=${post.win_rate_pct}%${decision.rollback_reason ? ` | reason=${decision.rollback_reason}` : ""}`,
				["evolution", rollback ? "rollback" : "accepted"],
			);
			saveLessonsData(lessonsData);
		} catch (error) {
			writeEvolutionEvidence({
				status: "post_mutation_write_failed",
				reason_code: "EVOLVE_LESSON_APPEND_FAILED",
				rollout_id: active.rollout_id,
				old_values: active.previous_values || null,
				new_values: active.new_values || null,
				metrics: { error: error.message },
				trigger,
			});
		}
	}

	return { ...decision, requires_reload: rollback };
}

function isFiniteNum(n) {
	return typeof n === "number" && Number.isFinite(n);
}

function avg(arr) {
	return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function clamp(val, min, max) {
	return Math.max(min, Math.min(max, val));
}

function nudge(current, target, maxChange) {
	const delta = target - current;
	const maxDelta = current * maxChange;
	if (Math.abs(delta) <= maxDelta) return target;
	return current + Math.sign(delta) * maxDelta;
}

export function getThresholdRolloutState() {
	return loadThresholdRolloutState();
}

export function evolveThresholds(perfData, config, { trigger = "auto" } = {}) {
	const recovery = recoverThresholdRolloutState(config, { trigger });
	if (recovery?.status === "blocked_invalid_state") {
		return recovery;
	}
	const lessonsState = loadLessonsData();
	if (lessonsState.invalid_state) {
		return invalidState("EVOLVE_LESSONS_STATE_INVALID", lessonsState.error, trigger);
	}
	const effectivePerfData = Array.isArray(perfData)
		? perfData
		: lessonsState.performance;
	if (!effectivePerfData || effectivePerfData.length < MIN_EVOLVE_POSITIONS) {
		return {
			changes: {},
			rationale: {},
			rollout: {
				status: "insufficient_history",
				total_positions_closed: effectivePerfData?.length || 0,
				min_positions_required: MIN_EVOLVE_POSITIONS,
			},
			requires_reload: false,
		};
	}
	const rolloutDecision = evaluatePendingThresholdRollout(effectivePerfData, config, { trigger, lessonsData: lessonsState });
	if (rolloutDecision?.status === "pending") {
		return {
			changes: {},
			rationale: {},
			rollout: rolloutDecision,
			requires_reload: false,
		};
	}
	if (
		rolloutDecision?.status === "accepted" ||
		rolloutDecision?.status === "rolled_back"
	) {
		return {
			changes: {},
			rationale: {},
			rollout: rolloutDecision,
			requires_reload: Boolean(rolloutDecision.requires_reload),
		};
	}

	const rolloutState = loadThresholdRolloutState();
	if (rolloutState.invalid_state) {
		return invalidState("EVOLVE_ROLLOUT_STATE_INVALID", rolloutState.error, trigger);
	}
	if (rolloutState.active) {
		return {
			changes: {},
			rationale: {},
			rollout: {
				status: "pending",
				closes_since_start: Math.max(
					0,
					perfData.length - (rolloutState.active.start_positions_count || 0),
				),
				min_closes_required:
					Number(rolloutState.active.min_closes_required) || MIN_ROLLOUT_CLOSES,
			},
			requires_reload: false,
		};
	}

	const winners = effectivePerfData.filter((p) => p.pnl_pct > 0);
	const losers = effectivePerfData.filter((p) => p.pnl_pct < -5);
	const hasSignal = winners.length >= 2 || losers.length >= 2;
	if (!hasSignal) return null;

	const changes = {};
	const rationale = {};
	{
		const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
		const loserFees = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
		const current = config.screening.minFeeActiveTvlRatio;

		if (winnerFees.length >= 2) {
			const minWinnerFee = Math.min(...winnerFees);
			if (minWinnerFee > current * 1.2) {
				const target = minWinnerFee * 0.85;
				const newVal = clamp(
					nudge(current, target, MAX_CHANGE_PER_STEP),
					0.05,
					10.0,
				);
				const rounded = Number(newVal.toFixed(2));
				if (rounded > current) {
					changes.minFeeActiveTvlRatio = rounded;
					rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
				}
			}
		}

		if (loserFees.length >= 2) {
			const maxLoserFee = Math.max(...loserFees);
			if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
				const minWinnerFee = Math.min(...winnerFees);
				if (minWinnerFee > maxLoserFee) {
					const target = maxLoserFee * 1.2;
					const newVal = clamp(
						nudge(current, target, MAX_CHANGE_PER_STEP),
						0.05,
						10.0,
					);
					const rounded = Number(newVal.toFixed(2));
					if (rounded > current && !changes.minFeeActiveTvlRatio) {
						changes.minFeeActiveTvlRatio = rounded;
						rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
					}
				}
			}
		}
	}

	{
		const loserOrganics = losers
			.map((p) => p.organic_score)
			.filter(isFiniteNum);
		const winnerOrganics = winners
			.map((p) => p.organic_score)
			.filter(isFiniteNum);
		const current = config.screening.minOrganic;

		if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
			const avgLoserOrganic = avg(loserOrganics);
			const avgWinnerOrganic = avg(winnerOrganics);
			if (avgWinnerOrganic - avgLoserOrganic >= 10) {
				const minWinnerOrganic = Math.min(...winnerOrganics);
				const target = Math.max(minWinnerOrganic - 3, current);
				const newVal = clamp(
					Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)),
					60,
					90,
				);
				if (newVal > current) {
					changes.minOrganic = newVal;
					rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
				}
			}
		}
	}

	if (Object.keys(changes).length === 0) {
		writeEvolutionEvidence({
			status: "no_change",
			reason_code: "EVOLVE_NO_CHANGE",
			metrics: { total_positions_closed: perfData.length },
			trigger,
		});
		return {
			changes: {},
			rationale: {},
			rollout: { status: "no_change" },
			requires_reload: false,
		};
	}

	const previousValues = {};
	for (const key of Object.keys(changes)) {
		previousValues[key] = config.screening[key];
	}

	const baselineSnapshot = getPerformanceSnapshot(
		effectivePerfData.slice(-MIN_EVOLVE_POSITIONS),
	);
	const rolloutId = `${Date.now()}-${Object.keys(changes).join("_")}`;
	const activeRollout = buildActiveRollout({
		phase: "apply_pending",
		rollout_id: rolloutId,
		start_positions_count: effectivePerfData.length,
		min_closes_required: MIN_ROLLOUT_CLOSES,
		changed_keys: Object.keys(changes),
		previous_values: previousValues,
		new_values: changes,
		baseline: baselineSnapshot,
	});
	try {
		saveThresholdRolloutState({
			active: activeRollout,
			history: rolloutState.history || [],
		});
	} catch (error) {
		const rollbackWrite = writeScreeningKeysToUserConfig(previousValues);
		revertScreeningChangesInConfig(config, previousValues);
		writeEvolutionEvidence({
			status: "blocked_invalid_state",
			reason_code: "EVOLVE_ROLLOUT_STATE_INVALID",
			rollout_id: rolloutId,
			old_values: previousValues,
			new_values: changes,
			metrics: {
				error: error.message,
				config_rollback_failed: !rollbackWrite.pass ? rollbackWrite.error : null,
			},
			trigger,
		});
		return {
			changes: {},
			rationale: {},
			rollout: {
				status: "blocked_invalid_state",
				reason_code: "EVOLVE_ROLLOUT_STATE_INVALID",
				error: error.message,
			},
			requires_reload: false,
		};
	}

	writeEvolutionEvidence({
		status: "started",
		reason_code: "EVOLVE_STARTED",
		rollout_id: rolloutId,
		old_values: previousValues,
		new_values: changes,
		metrics: {
			baseline: baselineSnapshot,
			total_positions_closed: effectivePerfData.length,
		},
		trigger,
	});

	const configWrite = writeScreeningKeysToUserConfig({
		...changes,
		_positionsAtEvolution: effectivePerfData.length,
	});
	if (!configWrite.pass) {
		return invalidState("EVOLVE_CONFIG_STATE_INVALID", configWrite.error, trigger);
	}
	applyScreeningChangesToConfig(config, changes);
	try {
		saveThresholdRolloutState({
			active: {
				...activeRollout,
				phase: "active",
			},
			history: rolloutState.history || [],
		});
	} catch {
		return {
			changes,
			rationale,
			rollout: {
				status: "pending_recovery",
				rollout_id: rolloutId,
				changed_keys: Object.keys(changes),
				min_closes_required: MIN_ROLLOUT_CLOSES,
			},
			requires_reload: true,
		};
	}
	try {
		appendEvolutionLesson(
			lessonsState,
			`[AUTO-EVOLVED @ ${effectivePerfData.length} positions] ${Object.entries(changes)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")} — ${Object.values(rationale).join("; ")}`,
			["evolution", "config_change"],
		);
		saveLessonsData(lessonsState);
	} catch (error) {
		writeEvolutionEvidence({
			status: "post_mutation_write_failed",
			reason_code: "EVOLVE_LESSON_APPEND_FAILED",
			rollout_id: rolloutId,
			old_values: previousValues,
			new_values: changes,
			metrics: { error: error.message },
			trigger,
		});
	}

	return {
		changes,
		rationale,
		rollout: {
			status: "started",
			rollout_id: rolloutId,
			changed_keys: Object.keys(changes),
			min_closes_required: MIN_ROLLOUT_CLOSES,
		},
		requires_reload: true,
	};
}
