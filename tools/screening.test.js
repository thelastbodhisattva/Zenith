import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCandidateSnapshot, rankCandidateSnapshots } from "./screening.js";

function buildPool(overrides = {}) {
  return {
    pool: overrides.pool || "pool-a",
    name: overrides.name || "Alpha-SOL",
    base: { mint: overrides.baseMint || "mint-a", symbol: "ALPHA" },
    fee_active_tvl_ratio: overrides.fee_active_tvl_ratio ?? 0.4,
    volume_window: overrides.volume_window ?? 50000,
    organic_score: overrides.organic_score ?? 85,
    holders: overrides.holders ?? 2500,
    active_pct: overrides.active_pct ?? 88,
    volatility: overrides.volatility ?? 4,
  };
}

test("evaluateCandidateSnapshot adds deterministic score and hard blocks", () => {
  const occupiedPools = new Set(["pool-blocked"]);
  const occupiedMints = new Set(["mint-held"]);

  const blocked = evaluateCandidateSnapshot(buildPool({ pool: "pool-blocked", baseMint: "mint-held" }), {
    occupiedPools,
    occupiedMints,
  });

  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.hard_blocks, ["pool_already_open", "base_token_already_held"]);
  assert.equal(typeof blocked.deterministic_score, "number");
  assert.equal(typeof blocked.score_breakdown.total_score, "number");
});

test("rankCandidateSnapshots sorts eligible pools by deterministic score", () => {
  const low = buildPool({ pool: "pool-low", baseMint: "mint-low", fee_active_tvl_ratio: 0.06, volume_window: 2000, organic_score: 62, holders: 700, active_pct: 60, volatility: 17 });
  const high = buildPool({ pool: "pool-high", baseMint: "mint-high", fee_active_tvl_ratio: 0.9, volume_window: 120000, organic_score: 91, holders: 3500, active_pct: 93, volatility: 5 });
  const blocked = buildPool({ pool: "pool-blocked", baseMint: "mint-blocked" });

  const ranked = rankCandidateSnapshots([low, high, blocked], {
    occupiedPools: new Set(["pool-blocked"]),
    occupiedMints: new Set(),
    limit: 3,
  });

  assert.equal(ranked.total_eligible, 2);
  assert.equal(ranked.candidates.length, 2);
  assert.equal(ranked.candidates[0].pool, "pool-high");
  assert.ok(ranked.candidates[0].deterministic_score > ranked.candidates[1].deterministic_score);
  assert.equal(ranked.blocked_summary.pool_already_open, 1);
});
