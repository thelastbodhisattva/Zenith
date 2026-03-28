import { config } from "./config.js";
import { getCounterfactualReviewSummary } from "./counterfactual-review.js";
import {
	getReplayEnvelope as getStoredReplayEnvelope,
	readReplayEnvelopeReport,
} from "./cycle-trace.js";
import { reconcileManagementEnvelope, reconcileScreeningEnvelope } from "./reconciliation.js";

export function getReplayEnvelope(cycleId) {
  return getStoredReplayEnvelope(cycleId);
}

export function listRecentReplayEnvelopes(limit = 10) {
	return readReplayEnvelopeReport().envelopes
		.slice(-limit)
		.reverse()
    .map((envelope) => ({
      cycle_id: envelope.cycle_id,
      cycle_type: envelope.cycle_type,
      timestamp: envelope.timestamp || null,
      reason_code: envelope.reason_code || null,
    }));
}

export function getReplayReview(cycleId) {
	const envelope = getReplayEnvelope(cycleId);
	if (!envelope) {
		return {
			found: false,
			cycle_id: cycleId,
			parse_errors: readReplayEnvelopeReport().parse_errors,
		};
	}

  const reconciliation = envelope.cycle_type === "management"
    ? reconcileManagementEnvelope(envelope, config)
    : reconcileScreeningEnvelope(envelope);

	return {
		found: true,
		cycle_id: cycleId,
		cycle_type: envelope.cycle_type,
		envelope,
		parse_errors: readReplayEnvelopeReport().parse_errors,
		reconciliation,
	};
}

export function getReplayReviewStats(limit = 25) {
	const report = readReplayEnvelopeReport();
	const recent = report.envelopes.slice(-limit);
	const stats = {
		total: recent.length,
		parse_errors: report.parse_errors.length,
		screening: 0,
    management: 0,
    fail_closed: 0,
    matches: 0,
    mismatches: 0,
  };

  for (const envelope of recent) {
    if (envelope.cycle_type === "screening") stats.screening += 1;
    if (envelope.cycle_type === "management") stats.management += 1;
    if (envelope.reason_code) stats.fail_closed += 1;
    const reconciliation = envelope.cycle_type === "management"
      ? reconcileManagementEnvelope(envelope, config)
      : reconcileScreeningEnvelope(envelope);
    if (reconciliation.status === "match") stats.matches += 1;
    else stats.mismatches += 1;
  }

  return {
    ...stats,
    counterfactual: getCounterfactualReviewSummary(Math.min(limit, 10)),
    recent_cycles: recent.slice(-10).reverse().map((envelope) => ({
      cycle_id: envelope.cycle_id,
      cycle_type: envelope.cycle_type,
      reason_code: envelope.reason_code || null,
    })),
  };
}

export function formatReplayReview(review) {
	if (!review?.found) {
		const lines = ["", "Replay review:", "", `  cycle_id: ${review?.cycle_id || "unknown"}`, "  found: no"];
		if (review?.parse_errors?.length) lines.push(`  parse_errors: ${review.parse_errors.length}`);
		lines.push("");
		return lines.join("\n");
	}

  const lines = ["", "Replay review:", ""];
  lines.push(`  cycle_id: ${review.cycle_id}`);
	lines.push(`  cycle_type: ${review.cycle_type}`);
	lines.push(`  reconciliation: ${review.reconciliation.status}`);
	if (review.parse_errors?.length) lines.push(`  parse_errors: ${review.parse_errors.length}`);
  if (review.envelope.reason_code) {
    lines.push(`  reason_code: ${review.envelope.reason_code}`);
  }
  if (review.reconciliation.mismatches?.length > 0) {
    lines.push("", "  Mismatches:");
    for (const mismatch of review.reconciliation.mismatches) {
      lines.push(`    - ${mismatch.field}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
