import path from "node:path";

import { config } from "./config.js";
import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";
import { getPerformanceHistory } from "./lessons.js";
import { log } from "./logger.js";

const DATA_DIR = "./data";
const GUARD_FILE = path.join(DATA_DIR, "portfolio-guards.json");

function emptyGuardState() {
	return {
		pause_until: null,
		reason_code: null,
		reason: null,
		triggered_at: null,
		cleared_at: null,
		history: [],
		metrics: {
			recent_loss_usd: 0,
			stop_loss_streak: 0,
			positions_considered: 0,
			equity_usd: 0,
			equity_high_watermark_usd: 0,
			drawdown_pct: 0,
			open_unrealized_loss_usd: 0,
			open_positions_considered: 0,
		},
		equity_snapshots: [],
	};
}

function loadGuardState() {
	const snapshot = readJsonSnapshotWithBackupSync(GUARD_FILE);
	if (!snapshot.value) {
		if (snapshot.error) {
			log("guard_warn", `Failed to read portfolio guards: ${snapshot.error}`);
			return {
				...emptyGuardState(),
				_snapshot_invalid: true,
				_snapshot_error: snapshot.error,
			};
		}
		return emptyGuardState();
	}
	const state = {
		...emptyGuardState(),
		...snapshot.value,
	};
	if (snapshot.source === "backup") {
		log("guard_warn", "Recovered portfolio guards from backup snapshot");
	}
	return state;
}

function saveGuardState(state) {
	writeJsonSnapshotAtomicSync(GUARD_FILE, state);
}

function appendHistory(state, entry) {
	state.history.push({ ts: new Date().toISOString(), ...entry });
	if (state.history.length > 20) {
		state.history = state.history.slice(-20);
	}
}

function normalizeReason(reason) {
	return String(reason || "")
		.trim()
		.toLowerCase()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function isStopLossCloseReason(reason) {
	const normalized = normalizeReason(reason);
	return normalized.includes("stop loss") || normalized.includes("stoploss");
}

function computeMetrics(history = []) {
	const positions = Array.isArray(history?.positions) ? history.positions : [];
	const recentLossUsd = Math.abs(
		positions
			.filter((row) => Number(row.pnl_usd) < 0)
			.reduce((sum, row) => sum + Number(row.pnl_usd || 0), 0),
	);

	let stopLossStreak = 0;
	for (let index = positions.length - 1; index >= 0; index -= 1) {
		if (!isStopLossCloseReason(positions[index]?.close_reason)) break;
		stopLossStreak += 1;
	}

	return {
		recent_loss_usd: Math.round(recentLossUsd * 100) / 100,
		stop_loss_streak: stopLossStreak,
		positions_considered: positions.length,
	};
}

function computePortfolioEquityUsd(portfolioSnapshot = {}) {
	const solUsd = Number(portfolioSnapshot?.sol_usd);
	const fromSolUsd = Number.isFinite(solUsd)
		? solUsd
		: Number(portfolioSnapshot?.sol || 0) *
			Number(portfolioSnapshot?.sol_price || 0);
	const tokenUsd = Array.isArray(portfolioSnapshot?.tokens)
		? portfolioSnapshot.tokens.reduce((sum, token) => {
				const usd = Number(token?.usd || 0);
				return sum + (Number.isFinite(usd) ? usd : 0);
			}, 0)
		: 0;
	const total = fromSolUsd + tokenUsd;
	return Number.isFinite(total) ? Math.max(0, total) : 0;
}

function updateEquitySnapshots(state, equityUsd, nowIso) {
	if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
		return {
			equity_usd: 0,
			equity_high_watermark_usd: Number(
				state.metrics?.equity_high_watermark_usd || 0,
			),
			drawdown_pct: 0,
		};
	}

	const snapshots = Array.isArray(state.equity_snapshots)
		? state.equity_snapshots
		: [];
	snapshots.push({ ts: nowIso, equity_usd: Number(equityUsd.toFixed(2)) });
	state.equity_snapshots = snapshots.slice(-200);

	const previousHigh = Number(state.metrics?.equity_high_watermark_usd || 0);
	const highWatermark = Math.max(previousHigh, equityUsd);
	const drawdownPct =
		highWatermark > 0 ? ((highWatermark - equityUsd) / highWatermark) * 100 : 0;

	return {
		equity_usd: Number(equityUsd.toFixed(2)),
		equity_high_watermark_usd: Number(highWatermark.toFixed(2)),
		drawdown_pct: Number(drawdownPct.toFixed(2)),
	};
}

function computeOpenRiskMetrics(openPositionPnls = []) {
	const rows = Array.isArray(openPositionPnls) ? openPositionPnls : [];
	const openUnrealizedLossUsd = rows.reduce((sum, row) => {
		const pnlUsd = Number(row?.pnl_usd);
		if (!Number.isFinite(pnlUsd) || pnlUsd >= 0) return sum;
		return sum + Math.abs(pnlUsd);
	}, 0);
	return {
		open_unrealized_loss_usd: Number(openUnrealizedLossUsd.toFixed(2)),
		open_positions_considered: rows.length,
	};
}

function buildTrigger(metrics) {
	const protections = config.protections;
	if (!protections.enabled) return null;

	if (
		protections.maxDrawdownPct > 0 &&
		metrics.drawdown_pct >= protections.maxDrawdownPct
	) {
		return {
			reason_code: "PORTFOLIO_DRAWDOWN_LIMIT",
			reason: `portfolio drawdown ${metrics.drawdown_pct.toFixed(2)}% >= ${protections.maxDrawdownPct.toFixed(2)}%`,
		};
	}

	if (
		protections.maxOpenUnrealizedLossUsd > 0 &&
		metrics.open_unrealized_loss_usd >= protections.maxOpenUnrealizedLossUsd
	) {
		return {
			reason_code: "OPEN_RISK_LIMIT",
			reason: `open unrealized loss $${metrics.open_unrealized_loss_usd.toFixed(2)} >= $${protections.maxOpenUnrealizedLossUsd.toFixed(2)}`,
		};
	}

	if (
		protections.stopLossStreakLimit > 0 &&
		metrics.stop_loss_streak >= protections.stopLossStreakLimit
	) {
		return {
			reason_code: "STOP_LOSS_STREAK",
			reason: `recent stop-loss streak ${metrics.stop_loss_streak} >= ${protections.stopLossStreakLimit}`,
		};
	}

	if (
		protections.maxRecentRealizedLossUsd > 0 &&
		metrics.recent_loss_usd >= protections.maxRecentRealizedLossUsd
	) {
		return {
			reason_code: "REALIZED_LOSS_LIMIT",
			reason: `recent realized loss $${metrics.recent_loss_usd.toFixed(2)} >= $${protections.maxRecentRealizedLossUsd.toFixed(2)}`,
		};
	}

	return null;
}

export function getPortfolioGuardStatus({ nowMs = Date.now() } = {}) {
	const state = loadGuardState();
	if (state._snapshot_invalid) {
		return {
			active: true,
			pause_until: null,
			remaining_ms: 0,
			reason_code: "GUARD_STATE_INVALID",
			reason: `portfolio guard state unreadable: ${state._snapshot_error}`,
			triggered_at: null,
			metrics: state.metrics,
			history: state.history,
		};
	}
	const pauseUntilMs = Date.parse(state.pause_until || "");
	const remainingMs = Number.isFinite(pauseUntilMs)
		? Math.max(0, pauseUntilMs - nowMs)
		: 0;
	return {
		active: remainingMs > 0,
		pause_until: remainingMs > 0 ? state.pause_until : null,
		remaining_ms: remainingMs,
		reason_code: remainingMs > 0 ? state.reason_code : null,
		reason: remainingMs > 0 ? state.reason : null,
		triggered_at: state.triggered_at,
		metrics: state.metrics,
		history: state.history,
	};
}

export function evaluatePortfolioGuard({
	nowMs = Date.now(),
	portfolioSnapshot = null,
	openPositionPnls = [],
} = {}) {
	const protections = config.protections;
	const state = loadGuardState();
	if (state._snapshot_invalid) {
		return {
			blocked: true,
			active: true,
			pause_until: null,
			remaining_ms: 0,
			reason_code: "GUARD_STATE_INVALID",
			reason: `portfolio guard state unreadable: ${state._snapshot_error}`,
			metrics: state.metrics,
			history: state.history,
		};
	}
	const current = getPortfolioGuardStatus({ nowMs });
	const nowIso = new Date(nowMs).toISOString();

	const history = getPerformanceHistory({
		hours: protections.recentLossWindowHours,
		limit: protections.maxReviewedCloses,
	});
	if (history.invalid_state) {
		return {
			blocked: true,
			active: true,
			pause_until: null,
			remaining_ms: 0,
			reason_code: "LESSONS_STATE_INVALID",
			reason: `lessons history unreadable: ${history.error}`,
			metrics: state.metrics,
			history: state.history,
		};
	}
	const realizedMetrics = computeMetrics(history);
	const equityMetrics = updateEquitySnapshots(
		state,
		computePortfolioEquityUsd(portfolioSnapshot),
		nowIso,
	);
	const openRiskMetrics = computeOpenRiskMetrics(openPositionPnls);
	const metrics = {
		...realizedMetrics,
		...equityMetrics,
		...openRiskMetrics,
	};
	state.metrics = metrics;

	if (current.active) {
		saveGuardState(state);
		return { blocked: true, ...current };
	}

	const trigger = buildTrigger(metrics);
	if (!trigger) {
		saveGuardState(state);
		return {
			blocked: false,
			active: false,
			pause_until: null,
			remaining_ms: 0,
			reason_code: null,
			reason: null,
			metrics,
			history: state.history,
		};
	}

	const pauseUntil = new Date(
		nowMs + protections.pauseMinutes * 60_000,
	).toISOString();
	state.pause_until = pauseUntil;
	state.reason_code = trigger.reason_code;
	state.reason = trigger.reason;
	state.triggered_at = new Date(nowMs).toISOString();
	state.cleared_at = null;
	appendHistory(state, {
		event: "triggered",
		reason_code: trigger.reason_code,
		reason: trigger.reason,
		pause_until: pauseUntil,
		metrics,
	});
	saveGuardState(state);
	log("guard_pause", `Portfolio guard triggered: ${trigger.reason}`);

	return {
		blocked: true,
		active: true,
		pause_until: pauseUntil,
		remaining_ms: Date.parse(pauseUntil) - nowMs,
		reason_code: trigger.reason_code,
		reason: trigger.reason,
		triggered_at: state.triggered_at,
		metrics,
		history: state.history,
	};
}

export function clearPortfolioGuardPause({
	reason = "operator override",
	nowMs = Date.now(),
} = {}) {
	const state = loadGuardState();
	const hadPause = Boolean(state.pause_until);
	state.pause_until = null;
	state.reason_code = null;
	state.reason = null;
	state.cleared_at = new Date(nowMs).toISOString();
	appendHistory(state, {
		event: "cleared",
		reason,
	});
	saveGuardState(state);
	if (hadPause) {
		log("guard_pause", `Portfolio guard cleared: ${reason}`);
	}
	return {
		cleared: hadPause,
		cleared_at: state.cleared_at,
		reason,
	};
}

export function formatPortfolioGuardReport(status = getPortfolioGuardStatus()) {
	const lines = ["", "Portfolio guard:", ""];
	lines.push(`  active: ${status.active ? "yes" : "no"}`);
	if (status.reason_code) lines.push(`  reason_code: ${status.reason_code}`);
	if (status.reason) lines.push(`  reason: ${status.reason}`);
	if (status.pause_until) lines.push(`  pause_until: ${status.pause_until}`);
	if (status.loaded_from_backup) lines.push("  loaded_from_backup: true");
	if (status.metrics) {
		lines.push(`  recent_loss_usd: ${status.metrics.recent_loss_usd}`);
		lines.push(`  stop_loss_streak: ${status.metrics.stop_loss_streak}`);
		lines.push(
			`  positions_considered: ${status.metrics.positions_considered}`,
		);
		lines.push(`  equity_usd: ${status.metrics.equity_usd}`);
		lines.push(
			`  equity_high_watermark_usd: ${status.metrics.equity_high_watermark_usd}`,
		);
		lines.push(`  drawdown_pct: ${status.metrics.drawdown_pct}`);
		lines.push(
			`  open_unrealized_loss_usd: ${status.metrics.open_unrealized_loss_usd}`,
		);
		lines.push(
			`  open_positions_considered: ${status.metrics.open_positions_considered}`,
		);
	}
	lines.push("");
	return lines.join("\n");
}
