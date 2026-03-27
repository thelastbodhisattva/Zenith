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

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.cycle_id, "screening-123");
    assert.equal(parsed.active_regime, "neutral");
    assert.equal(parsed.alternates.length, 2);

    const summary = getCounterfactualReviewSummary(5);
    assert.equal(summary.total_reviews, 1);
    assert.equal(summary.total_alternates, 2);

    const attached = attachCounterfactualRealizedOutcome({
      pool_address: "pool-a",
      regime_label: "neutral",
      pnl_pct: -6.5,
      pnl_usd: -18,
      close_reason: "stop loss",
    });
    assert.equal(attached.updated, true);

    const resolved = getCounterfactualReviewSummary(5);
    assert.equal(resolved.resolved_reviews, 1);
    assert.equal(resolved.divergent_resolved_losses, 1);
    assert.equal(resolved.recent_reviews[0].realized_outcome.usefulness_hint, "review_divergent_alternates");
  } finally {
    if (originalPath) process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE = originalPath;
    else delete process.env.ZENITH_COUNTERFACTUAL_REVIEW_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
