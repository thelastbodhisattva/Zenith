import fs from "fs";
import path from "path";

const COUNTERFACTUAL_REVIEW_FILE = process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE || "./data/counterfactual-review.jsonl";

function readReviews() {
  if (!fs.existsSync(COUNTERFACTUAL_REVIEW_FILE)) return [];
  return fs.readFileSync(COUNTERFACTUAL_REVIEW_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeReviews(reviews) {
  const dir = path.dirname(COUNTERFACTUAL_REVIEW_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const content = reviews.map((review) => JSON.stringify(review)).join("\n");
  fs.writeFileSync(COUNTERFACTUAL_REVIEW_FILE, content ? `${content}\n` : "");
}

export function appendCounterfactualReview(entry) {
  if (!entry || typeof entry !== "object") return null;

  const dir = path.dirname(COUNTERFACTUAL_REVIEW_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const record = {
    ts: new Date().toISOString(),
    ...entry,
  };
  fs.appendFileSync(COUNTERFACTUAL_REVIEW_FILE, `${JSON.stringify(record)}\n`);
  return record;
}

export function listCounterfactualReviews(limit = 10) {
  return readReviews()
    .slice(-limit)
    .reverse();
}

export function attachCounterfactualRealizedOutcome({
  pool_address,
  regime_label = null,
  pnl_pct = null,
  pnl_usd = null,
  close_reason = null,
  closed_at = new Date().toISOString(),
} = {}) {
  if (!pool_address) return { updated: false, reason: "pool_address_required" };

  const reviews = readReviews();
  const matchIndex = [...reviews]
    .reverse()
    .findIndex((review) => review.active_selected_pool === pool_address && !review.realized_outcome && (!regime_label || !review.active_regime || review.active_regime === regime_label));

  if (matchIndex === -1) {
    return { updated: false, reason: "no_matching_counterfactual_review" };
  }

  const actualIndex = reviews.length - 1 - matchIndex;
  const review = reviews[actualIndex];
  const divergentCount = (review.alternates || []).filter((row) => row.diverged_from_active).length;
  review.realized_outcome = {
    pnl_pct: Number.isFinite(Number(pnl_pct)) ? Number(pnl_pct) : null,
    pnl_usd: Number.isFinite(Number(pnl_usd)) ? Number(pnl_usd) : null,
    close_reason,
    closed_at,
    usefulness_hint: divergentCount > 0 && Number(pnl_pct) < 0
      ? "review_divergent_alternates"
      : divergentCount > 0
        ? "active_choice_profitable"
        : "no_divergent_alternates",
  };
  writeReviews(reviews);

  return {
    updated: true,
    cycle_id: review.cycle_id,
    usefulness_hint: review.realized_outcome.usefulness_hint,
  };
}

export function getCounterfactualReviewSummary(limit = 10) {
  const reviews = listCounterfactualReviews(limit);
  const alternates = reviews.flatMap((review) => Array.isArray(review.alternates) ? review.alternates : []);
  const divergent = alternates.filter((row) => row.diverged_from_active).length;
  const resolved = reviews.filter((review) => review.realized_outcome).length;
  const divergentResolvedLosses = reviews.filter((review) => {
    const divergentCount = (review.alternates || []).filter((row) => row.diverged_from_active).length;
    return divergentCount > 0 && Number(review.realized_outcome?.pnl_pct) < 0;
  }).length;
  return {
    total_reviews: reviews.length,
    total_alternates: alternates.length,
    divergent_alternates: divergent,
    resolved_reviews: resolved,
    divergent_resolved_losses: divergentResolvedLosses,
    recent_reviews: reviews.map((review) => ({
      cycle_id: review.cycle_id,
      active_regime: review.active_regime,
      active_selected_pool: review.active_selected_pool,
      realized_outcome: review.realized_outcome || null,
      alternates: (review.alternates || []).map((row) => ({
        regime: row.regime,
        selected_pool: row.selected_pool,
        diverged_from_active: row.diverged_from_active,
      })),
    })),
  };
}
