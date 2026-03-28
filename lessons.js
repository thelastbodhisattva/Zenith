/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import { attachCounterfactualRealizedOutcome } from "./counterfactual-review.js";
import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";
import { writeEvidenceBundle } from "./evidence-bundles.js";
import { log } from "./logger.js";
import { recordNegativeRegimeOutcome } from "./negative-regime-memory.js";
import { inferPerformanceRegimeSignal } from "./regime-packs.js";

export {
	evolveThresholds,
	getThresholdRolloutState,
	recoverThresholdRolloutState,
} from "./lessons-rollout.js";

const LESSONS_FILE = process.env.ZENITH_LESSONS_FILE || "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5; // don't evolve until we have real data

function emptyLessonsData() {
	return { lessons: [], performance: [] };
}

function load() {
	const snapshot = readJsonSnapshotWithBackupSync(LESSONS_FILE);
	if (!snapshot.value) {
		if (!snapshot.error) return emptyLessonsData();
		log("lessons_warn", `Failed to read lessons store: ${snapshot.error}`);
		return {
			...emptyLessonsData(),
			_invalid_state: true,
			_error: snapshot.error,
		};
	}
	return {
		...emptyLessonsData(),
		...snapshot.value,
		_loaded_from_backup: snapshot.source === "backup",
	};
}

function save(data) {
	writeJsonSnapshotAtomicSync(LESSONS_FILE, data);
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
	const data = load();
	if (data._invalid_state) {
		writeEvidenceBundle({
			cycle_id: `lessons:${perf.position || Date.now()}`,
			cycle_type: "lessons_performance",
			status: "blocked_invalid_state",
			reason_code: "LESSONS_STATE_INVALID",
			runbook_slug: "runbook-lessons-state-invalid",
			error: data._error,
			written_at: new Date().toISOString(),
		});
		log("lessons_warn", `Skipping recordPerformance because lessons store is unreadable: ${data._error}`);
		return { blocked: true, reason_code: "LESSONS_STATE_INVALID", error: data._error };
	}

	const pnl_usd =
		perf.final_value_usd + perf.fees_earned_usd - perf.initial_value_usd;
	const inventory_pnl_usd = perf.final_value_usd - perf.initial_value_usd;
	const pnl_pct =
		perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0;
	const fee_yield_pct =
		perf.initial_value_usd > 0
			? (perf.fees_earned_usd / perf.initial_value_usd) * 100
			: 0;
	const range_efficiency =
		perf.minutes_held > 0
			? (perf.minutes_in_range / perf.minutes_held) * 100
			: 0;
	const tokenTypeDistribution = inferTokenTypeDistribution(perf);

	const entry = {
		...perf,
		pnl_usd: Math.round(pnl_usd * 100) / 100,
		inventory_pnl_usd: Math.round(inventory_pnl_usd * 100) / 100,
		fee_component_usd: Math.round((perf.fees_earned_usd || 0) * 100) / 100,
		pnl_after_fees_usd:
			Math.round((inventory_pnl_usd + (perf.fees_earned_usd || 0)) * 100) / 100,
		pnl_pct: Math.round(pnl_pct * 100) / 100,
		fee_yield_pct: Math.round(fee_yield_pct * 100) / 100,
		range_efficiency: Math.round(range_efficiency * 10) / 10,
		claim_count: perf.claim_count ?? 0,
		rebalance_count: perf.rebalance_count ?? 0,
		operational_touch_count:
			(perf.claim_count ?? 0) + (perf.rebalance_count ?? 0) + 1,
		token_type_distribution: tokenTypeDistribution,
		recorded_at: new Date().toISOString(),
	};

	data.performance.push(entry);

	// Derive and store a lesson
	const lesson = derivLesson(entry);
	if (lesson) {
		data.lessons.push(lesson);
		log("lessons", `New lesson: ${lesson.rule}`);
	}

	save(data);

	// Update pool-level memory
	if (perf.pool) {
		const { recordPoolDeploy } = await import("./pool-memory.js");
		recordPoolDeploy(perf.pool, {
			pool_name: perf.pool_name,
			base_mint: perf.base_mint,
			deployed_at: perf.deployed_at,
			closed_at: entry.recorded_at,
			pnl_pct: entry.pnl_pct,
			pnl_usd: entry.pnl_usd,
			range_efficiency: entry.range_efficiency,
			minutes_held: perf.minutes_held,
			close_reason: perf.close_reason,
			strategy: perf.strategy,
			volatility: perf.volatility,
			fee_yield_pct: entry.fee_yield_pct,
			inventory_pnl_usd: entry.inventory_pnl_usd,
			fee_component_usd: entry.fee_component_usd,
			operational_touch_count: entry.operational_touch_count,
			token_type_distribution: tokenTypeDistribution.key,
			regime_label: perf.regime_label || inferPerformanceRegimeSignal(perf),
		});
	}

	recordNegativeRegimeOutcome({
		regime_label: perf.regime_label || inferPerformanceRegimeSignal(perf),
		strategy: perf.strategy,
		pnl_pct: entry.pnl_pct,
		close_reason: perf.close_reason,
	});

	attachCounterfactualRealizedOutcome({
		pool_address: perf.pool,
		regime_label: perf.regime_label || inferPerformanceRegimeSignal(perf),
		pnl_pct: entry.pnl_pct,
		pnl_usd: entry.pnl_usd,
		close_reason: perf.close_reason,
		closed_at: entry.recorded_at,
		decision_cycle_id: perf.opened_by_cycle_id || null,
		decision_action_id: perf.opened_by_action_id || null,
		decision_workflow_id: perf.opened_by_workflow_id || null,
	});

	// Mirror generalized strategy outcomes into fuzzy memory.
	try {
		const { rememberStrategy } = await import("./memory.js");
		const outcome = pnl_pct >= 0 ? "profitable" : "unprofitable";
		if (perf.strategy && perf.bin_step != null) {
			rememberStrategy(
				{ strategy: perf.strategy, bin_step: perf.bin_step },
				`${outcome}, PnL ${pnl_pct.toFixed(1)}%, vol=${perf.volatility}, fee_tvl=${perf.fee_tvl_ratio}`,
			);
		}
	} catch (error) {
		log("memory", `Failed to mirror lesson into memory: ${error.message}`);
	}

	try {
		const { rememberTokenTypeDistribution } = await import("./memory.js");
		rememberTokenTypeDistribution({
			distribution_key: tokenTypeDistribution.key,
			strategy: perf.strategy || null,
			pool_address: perf.pool || null,
			pool_name: perf.pool_name || null,
			pnl_pct: entry.pnl_pct,
			fee_yield_pct: entry.fee_yield_pct,
			minutes_held: perf.minutes_held ?? null,
			success: entry.pnl_pct >= 0,
		});
	} catch (error) {
		log(
			"memory",
			`Failed to store distribution stats in memory: ${error.message}`,
		);
	}

	// Evolve thresholds every 5 closed positions
	if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
		const { config, reloadScreeningThresholds } = await import("./config.js");
		const result = evolveThresholds(data.performance, config, { trigger: "auto" });
		if (
			result?.requires_reload ||
			(result?.changes && Object.keys(result.changes).length > 0)
		) {
			reloadScreeningThresholds();
			if (result?.changes && Object.keys(result.changes).length > 0) {
				log(
					"evolve",
					`Auto-evolved thresholds: ${JSON.stringify(result.changes)}`,
				);
			}
			if (result?.rollout?.status === "rolled_back") {
				log("evolve", `Auto-rollback applied for rollout ${result.rollout.rollout_id}`);
			}
		}
	}

	// Fire-and-forget sync to hive mind (if enabled)
	import("./hive-mind.js").then((m) => m.syncToHive()).catch(() => {});
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
	const tags = [];

	// Categorize outcome
	const outcome =
		perf.pnl_pct >= 5
			? "good"
			: perf.pnl_pct >= 0
				? "neutral"
				: perf.pnl_pct >= -5
					? "poor"
					: "bad";

	if (outcome === "neutral") return null; // nothing interesting to learn

	// Build context description
	const context = [
		`${perf.pool_name}`,
		`strategy=${perf.strategy}`,
		`bin_step=${perf.bin_step}`,
		`volatility=${perf.volatility}`,
		`fee_tvl_ratio=${perf.fee_tvl_ratio}`,
		`organic=${perf.organic_score}`,
		`bin_range=${typeof perf.bin_range === "object" ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
	].join(", ");

	let rule = "";

	if (outcome === "good" || outcome === "bad") {
		if (perf.range_efficiency < 30 && outcome === "bad") {
			rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
			tags.push(
				"oor",
				perf.strategy,
				perf.token_type_distribution?.key,
				`volatility_${Math.round(perf.volatility)}`,
			);
		} else if (perf.range_efficiency > 80 && outcome === "good") {
			rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
			tags.push("efficient", perf.strategy, perf.token_type_distribution?.key);
		} else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
			rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
			tags.push("volume_collapse");
		} else if (outcome === "good") {
			rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
			tags.push("worked", perf.token_type_distribution?.key);
		} else {
			rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
			tags.push("failed", perf.token_type_distribution?.key);
		}
	}

	if (!rule) return null;

	return {
		id: Date.now(),
		rule,
		tags,
		outcome,
		context,
		pnl_pct: perf.pnl_pct,
		range_efficiency: perf.range_efficiency,
		pool: perf.pool,
		created_at: new Date().toISOString(),
	};
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(
	rule,
	tags = [],
	{ pinned = false, role = null } = {},
) {
	const data = load();
	data.lessons.push({
		id: Date.now(),
		rule,
		tags,
		outcome: "manual",
		pinned: !!pinned,
		role: role || null,
		created_at: new Date().toISOString(),
	});
	save(data);
	log(
		"lessons",
		`Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`,
	);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
	const data = load();
	const lesson = data.lessons.find((l) => l.id === id);
	if (!lesson) return { found: false };
	lesson.pinned = true;
	save(data);
	log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
	return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
	const data = load();
	const lesson = data.lessons.find((l) => l.id === id);
	if (!lesson) return { found: false };
	lesson.pinned = false;
	save(data);
	return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({
	role = null,
	pinned = null,
	tag = null,
	limit = 30,
} = {}) {
	const data = load();
	let lessons = [...data.lessons];

	if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
	if (role) lessons = lessons.filter((l) => !l.role || l.role === role);
	if (tag) lessons = lessons.filter((l) => l.tags?.includes(tag));

	return {
		total: lessons.length,
		lessons: lessons.slice(-limit).map((l) => ({
			id: l.id,
			rule: l.rule.slice(0, 120),
			tags: l.tags,
			outcome: l.outcome,
			pinned: !!l.pinned,
			role: l.role || "all",
			created_at: l.created_at?.slice(0, 10),
		})),
	};
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
	const data = load();
	const before = data.lessons.length;
	data.lessons = data.lessons.filter((l) => l.id !== id);
	save(data);
	return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
	const data = load();
	const before = data.lessons.length;
	const kw = keyword.toLowerCase();
	data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
	save(data);
	return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
	const data = load();
	const count = data.lessons.length;
	data.lessons = [];
	save(data);
	return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
	const data = load();
	const count = data.performance.length;
	data.performance = [];
	save(data);
	return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
	SCREENER: [
		"screening",
		"narrative",
		"strategy",
		"deployment",
		"token",
		"volume",
		"entry",
		"bundler",
		"holders",
		"organic",
	],
	MANAGER: [
		"management",
		"risk",
		"oor",
		"fees",
		"position",
		"hold",
		"close",
		"pnl",
		"rebalance",
		"claim",
	],
	GENERAL: [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
	// Support legacy call signature: getLessonsForPrompt(20)
	if (typeof opts === "number") opts = { maxLessons: opts };

	const { agentType = "GENERAL", maxLessons } = opts;

	const data = load();
	if (data._invalid_state) return null;
	if (data.lessons.length === 0) return null;

	// Smaller caps for automated cycles — they don't need the full lesson history
	const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
	const PINNED_CAP = isAutoCycle ? 5 : 10;
	const ROLE_CAP = isAutoCycle ? 6 : 15;
	const RECENT_CAP = maxLessons ?? (isAutoCycle ? 10 : 35);

	const outcomePriority = {
		bad: 0,
		poor: 1,
		failed: 1,
		good: 2,
		worked: 2,
		manual: 1,
		neutral: 3,
		evolution: 2,
	};
	const byPriority = (a, b) =>
		(outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

	// ── Tier 1: Pinned ──────────────────────────────────────────────
	// Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
	const pinned = data.lessons
		.filter(
			(l) =>
				l.pinned &&
				(!l.role || l.role === agentType || agentType === "GENERAL"),
		)
		.sort(byPriority)
		.slice(0, PINNED_CAP);

	const usedIds = new Set(pinned.map((l) => l.id));

	// ── Tier 2: Role-matched ────────────────────────────────────────
	const roleTags = ROLE_TAGS[agentType] || [];
	const roleMatched = data.lessons
		.filter((l) => {
			if (usedIds.has(l.id)) return false;
			// Include if: lesson has no role restriction OR matches this role
			const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
			// Include if: lesson has role-relevant tags OR no tags (general)
			const tagOk =
				roleTags.length === 0 ||
				!l.tags?.length ||
				l.tags.some((t) => roleTags.includes(t));
			return roleOk && tagOk;
		})
		.sort(byPriority)
		.slice(0, ROLE_CAP);

	roleMatched.forEach((l) => {
		usedIds.add(l.id);
	});

	// ── Tier 3: Recent fill ─────────────────────────────────────────
	const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
	const recent =
		remainingBudget > 0
			? data.lessons
					.filter((l) => !usedIds.has(l.id))
					.sort((a, b) =>
						(b.created_at || "").localeCompare(a.created_at || ""),
					)
					.slice(0, remainingBudget)
			: [];

	const selected = [...pinned, ...roleMatched, ...recent];
	if (selected.length === 0) return null;

	const sections = [];
	if (pinned.length)
		sections.push(`── PINNED (${pinned.length}) ──\n${fmt(pinned)}`);
	if (roleMatched.length)
		sections.push(
			`── ${agentType} (${roleMatched.length}) ──\n${fmt(roleMatched)}`,
		);
	if (recent.length)
		sections.push(`── RECENT (${recent.length}) ──\n${fmt(recent)}`);

	return sections.join("\n\n");
}

function fmt(lessons) {
	return lessons
		.map((l) => {
			const date = l.created_at
				? l.created_at.slice(0, 16).replace("T", " ")
				: "unknown";
			const pin = l.pinned ? "📌 " : "";
			return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
		})
		.join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
	const data = load();
	if (data._invalid_state) {
		return {
			hours,
			count: 0,
			positions: [],
			invalid_state: true,
			error: data._error,
		};
	}
	const p = data.performance;

	if (p.length === 0) return { positions: [], count: 0, hours };

	const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

	const filtered = p
		.filter((r) => r.recorded_at >= cutoff)
		.slice(-limit)
		.map((r) => ({
			pool_name: r.pool_name,
			pool: r.pool,
			strategy: r.strategy,
			pnl_usd: r.pnl_usd,
			inventory_pnl_usd: r.inventory_pnl_usd,
			fee_component_usd: r.fee_component_usd,
			pnl_pct: r.pnl_pct,
			fees_earned_usd: r.fees_earned_usd,
			operational_touch_count: r.operational_touch_count,
			range_efficiency: r.range_efficiency,
			minutes_held: r.minutes_held,
			close_reason: r.close_reason,
			closed_at: r.recorded_at,
		}));

	const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
	const wins = filtered.filter((r) => r.pnl_usd > 0).length;

	return {
		hours,
		count: filtered.length,
		total_pnl_usd: Math.round(totalPnl * 100) / 100,
		win_rate_pct:
			filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
		positions: filtered,
	};
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
	const data = load();
	if (data._invalid_state) {
		return {
			invalid_state: true,
			error: data._error,
			total_positions_closed: 0,
			total_lessons: 0,
		};
	}
	const p = data.performance;

	if (p.length === 0) return null;

	const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
	const totalInventoryPnl = p.reduce(
		(s, x) => s + (x.inventory_pnl_usd ?? 0),
		0,
	);
	const totalFeeComponent = p.reduce(
		(s, x) => s + (x.fee_component_usd ?? 0),
		0,
	);
	const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
	const avgRangeEfficiency =
		p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
	const avgOperationalTouches =
		p.reduce((s, x) => s + (x.operational_touch_count ?? 0), 0) / p.length;
	const wins = p.filter((x) => x.pnl_usd > 0).length;

	return {
		total_positions_closed: p.length,
		total_pnl_usd: Math.round(totalPnl * 100) / 100,
		total_inventory_pnl_usd: Math.round(totalInventoryPnl * 100) / 100,
		total_fee_component_usd: Math.round(totalFeeComponent * 100) / 100,
		avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
		avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
		avg_operational_touch_count: Math.round(avgOperationalTouches * 10) / 10,
		win_rate_pct: Math.round((wins / p.length) * 100),
		total_lessons: data.lessons.length,
		token_type_distribution_success_rates: summarizeTokenTypeDistributions(p),
	};
}

export function getStrategyProofSummary({ hours = 168 } = {}) {
	const data = load();
	if (data._invalid_state) {
		return {
			invalid_state: true,
			error: data._error,
			window_hours: hours,
			positions_analyzed: 0,
		};
	}
	const since = Date.now() - hours * 60 * 60 * 1000;
	const positions = (data.performance || []).filter(
		(row) => new Date(row.recorded_at).getTime() >= since,
	);
	if (positions.length === 0) return null;

	const byStrategy = new Map();
	const closeReasons = new Map();
	let totalInventory = 0;
	let totalFees = 0;
	let totalTouches = 0;

	for (const row of positions) {
		const strategy = row.strategy || "unknown";
		const current = byStrategy.get(strategy) || {
			strategy,
			count: 0,
			wins: 0,
			totalPnlPct: 0,
			totalInventoryUsd: 0,
			totalFeesUsd: 0,
			totalTouches: 0,
		};
		current.count += 1;
		current.wins += row.pnl_usd > 0 ? 1 : 0;
		current.totalPnlPct += row.pnl_pct || 0;
		current.totalInventoryUsd += row.inventory_pnl_usd || 0;
		current.totalFeesUsd += row.fee_component_usd || 0;
		current.totalTouches += row.operational_touch_count || 0;
		byStrategy.set(strategy, current);

		const closeReason = row.close_reason || "unknown";
		closeReasons.set(closeReason, (closeReasons.get(closeReason) || 0) + 1);
		totalInventory += row.inventory_pnl_usd || 0;
		totalFees += row.fee_component_usd || 0;
		totalTouches += row.operational_touch_count || 0;
	}

	return {
		window_hours: hours,
		positions_analyzed: positions.length,
		total_inventory_pnl_usd: Math.round(totalInventory * 100) / 100,
		total_fee_component_usd: Math.round(totalFees * 100) / 100,
		fee_share_of_total_pnl_pct:
			positions.length && totalInventory + totalFees !== 0
				? Math.round((totalFees / (totalInventory + totalFees)) * 1000) / 10
				: 0,
		avg_operational_touch_count:
			Math.round((totalTouches / positions.length) * 10) / 10,
		strategy_breakdown: [...byStrategy.values()]
			.map((row) => ({
				strategy: row.strategy,
				count: row.count,
				win_rate_pct: Math.round((row.wins / row.count) * 100),
				avg_pnl_pct: Math.round((row.totalPnlPct / row.count) * 100) / 100,
				avg_inventory_pnl_usd:
					Math.round((row.totalInventoryUsd / row.count) * 100) / 100,
				avg_fee_component_usd:
					Math.round((row.totalFeesUsd / row.count) * 100) / 100,
				avg_operational_touch_count:
					Math.round((row.totalTouches / row.count) * 10) / 10,
			}))
			.sort((a, b) => b.count - a.count),
		top_close_reasons: [...closeReasons.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([reason, count]) => ({ reason, count })),
	};
}

function inferTokenTypeDistribution(perf) {
	const strategy = String(perf.strategy || "").toLowerCase();

	if (strategy === "bid_ask") {
		return {
			key: "quote_heavy",
			label: "quote-heavy",
			source: "strategy",
		};
	}

	if (strategy === "spot" || strategy === "curve") {
		return {
			key: "balanced",
			label: "balanced",
			source: "strategy",
		};
	}

	return {
		key: "unknown",
		label: "unknown",
		source: "strategy",
	};
}

function summarizeTokenTypeDistributions(performance) {
	const grouped = {};

	for (const row of performance) {
		const key = row.token_type_distribution?.key || "unknown";
		if (!grouped[key]) {
			grouped[key] = { total_closed: 0, wins: 0, avg_pnl_pct: 0 };
		}

		grouped[key].total_closed += 1;
		if ((row.pnl_pct ?? 0) >= 0) grouped[key].wins += 1;
		grouped[key].avg_pnl_pct =
			(grouped[key].avg_pnl_pct * (grouped[key].total_closed - 1) +
				(row.pnl_pct ?? 0)) /
			grouped[key].total_closed;
	}

	return Object.fromEntries(
		Object.entries(grouped).map(([key, stats]) => [
			key,
			{
				total_closed: stats.total_closed,
				win_rate_pct: Math.round((stats.wins / stats.total_closed) * 100),
				avg_pnl_pct: Math.round(stats.avg_pnl_pct * 100) / 100,
			},
		]),
	);
}
