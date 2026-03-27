import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("appendCounterfactualReview persists observational records only", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-counterfactual-test-"));
  const originalPath = process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE;

  try {
    const filePath = path.join(tempDir, "counterfactual.jsonl");
    process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE = filePath;

    const { appendCounterfactualReview, attachCounterfactualRealizedOutcome, getCounterfactualReviewSummary } = await import(`./counterfactual-review.js?test=${Date.now()}`);
    appendCounterfactualReview({
      cycle_id: "screening-123",
      active_regime: "neutral",
      active_selected_pool: "pool-a",
      alternates: [
        { regime: "defensive", selected_pool: "pool-b", diverged_from_active: true },
        { regime: "offensive", selected_pool: "pool-a", diverged_from_active: false },
      ],
    });
    appendCounterfactualReview({
      cycle_id: "screening-456",
      active_regime: "neutral",
      active_selected_pool: "pool-a",
      alternates: [
        { regime: "defensive", selected_pool: "pool-c", diverged_from_active: true },
      ],
    });

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.cycle_id, "screening-123");
    assert.equal(parsed.active_regime, "neutral");
    assert.equal(parsed.alternates.length, 2);

    const summary = getCounterfactualReviewSummary(5);
    assert.equal(summary.total_reviews, 2);
    assert.equal(summary.total_alternates, 3);

    const attached = attachCounterfactualRealizedOutcome({
      pool_address: "pool-a",
      regime_label: "neutral",
      pnl_pct: -6.5,
      pnl_usd: -18,
      close_reason: "stop loss",
      decision_cycle_id: "screening-123",
    });
    assert.equal(attached.updated, true);
    assert.equal(attached.cycle_id, "screening-123");

    const resolved = getCounterfactualReviewSummary(5);
    assert.equal(resolved.resolved_reviews, 1);
    assert.equal(resolved.divergent_resolved_losses, 1);
    const matchingReview = resolved.recent_reviews.find((review) => review.cycle_id === "screening-123");
    assert.equal(matchingReview.realized_outcome.usefulness_hint, "review_divergent_alternates");
  } finally {
    if (originalPath) process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE = originalPath;
    else delete process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
