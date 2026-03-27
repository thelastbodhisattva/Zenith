import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyRuntimeRegime,
  getPerformanceSizingMultiplier,
  getRiskSizingMultiplier,
  listCounterfactualRegimes,
  resolveRegimePackContext,
} from "./regime-packs.js";

test("classifyRuntimeRegime returns deterministic fixed regime names", () => {
  const defensive = classifyRuntimeRegime({
    walletSol: 0.8,
    deployFloor: 0.5,
    gasReserve: 0.2,
    positionsCount: 2,
    maxPositions: 3,
  });
  assert.equal(defensive.regime, "defensive");

  const offensive = classifyRuntimeRegime({
    walletSol: 5,
    deployFloor: 0.5,
    gasReserve: 0.2,
    positionsCount: 0,
    maxPositions: 3,
    performanceSummary: {
      total_positions_closed: 12,
      win_rate_pct: 72,
      avg_pnl_pct: 2.1,
    },
  });
  assert.equal(offensive.regime, "offensive");

  const hotMarket = classifyRuntimeRegime({
    walletSol: 2,
    deployFloor: 0.5,
    gasReserve: 0.2,
    positionsCount: 0,
    maxPositions: 3,
    marketPools: [
      { volatility: 10, price_change_pct: 55, organic_score: 72 },
      { volatility: 9, price_change_pct: 40, organic_score: 70 },
      { volatility: 11, price_change_pct: 65, organic_score: 68 },
    ],
  });
  assert.equal(hotMarket.regime, "defensive");
});

test("resolveRegimePackContext builds non-mutating effective screening config", () => {
  const baseScreening = {
    minFeeActiveTvlRatio: 0.05,
    minOrganic: 60,
    minVolume: 500,
    minHolders: 500,
  };
  const resolved = resolveRegimePackContext({
    baseScreeningConfig: baseScreening,
    classification: { regime: "defensive", reason: "test" },
  });

  assert.equal(resolved.regime, "defensive");
  assert.ok(resolved.effectiveScreeningConfig.minOrganic > baseScreening.minOrganic);
  assert.equal(baseScreening.minOrganic, 60);
  assert.deepEqual(listCounterfactualRegimes("defensive").sort(), ["neutral", "offensive"]);
});

test("sizing multipliers remain deterministic from context", () => {
  assert.equal(getPerformanceSizingMultiplier({ total_positions_closed: 8, win_rate_pct: 35, avg_pnl_pct: -2 }), 0.8);
  assert.equal(getPerformanceSizingMultiplier({ total_positions_closed: 8, win_rate_pct: 70, avg_pnl_pct: 2 }), 1.1);
  assert.equal(getRiskSizingMultiplier({ positionsCount: 2, maxPositions: 3 }), 0.85);
  assert.equal(getRiskSizingMultiplier({ positionsCount: 0, maxPositions: 3 }), 1.05);
});

test("applyRegimeHysteresis requires confirmation before switching away from current regime", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-regime-hysteresis-test-"));
  const originalStateFile = process.env.ZENITH_REGIME_STATE_FILE;

  try {
    process.env.ZENITH_REGIME_STATE_FILE = path.join(tempDir, "regime-state.json");
    const { applyRegimeHysteresis } = await import(`./regime-packs.js?test=${Date.now()}`);

    const first = applyRegimeHysteresis({ classification: { regime: "offensive", reason: "seed", confidence: "medium" }, nowMs: 0 });
    assert.equal(first.regime, "offensive");

    const pending = applyRegimeHysteresis({ classification: { regime: "neutral", reason: "default_baseline", confidence: "low" }, nowMs: 10 * 60 * 1000 });
    assert.equal(pending.regime, "offensive");
    assert.equal(pending.hysteresis_reason, "active_dwell_window");

    const confirmed = applyRegimeHysteresis({ classification: { regime: "neutral", reason: "default_baseline", confidence: "low" }, nowMs: 60 * 60 * 1000 });
    assert.equal(confirmed.regime, "neutral");
    assert.equal(confirmed.hysteresis_reason, "confirmed_switch");
  } finally {
    if (originalStateFile) process.env.ZENITH_REGIME_STATE_FILE = originalStateFile;
    else delete process.env.ZENITH_REGIME_STATE_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applyRegimeHysteresis switches immediately for high-confidence defensive classification", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-regime-hysteresis-protective-test-"));
  const originalStateFile = process.env.ZENITH_REGIME_STATE_FILE;

  try {
    process.env.ZENITH_REGIME_STATE_FILE = path.join(tempDir, "regime-state.json");
    const { applyRegimeHysteresis } = await import(`./regime-packs.js?test=${Date.now()}`);

    applyRegimeHysteresis({ classification: { regime: "offensive", reason: "seed", confidence: "medium" } });
    const defensive = applyRegimeHysteresis({
      classification: {
        regime: "defensive",
        reason: "weak_recent_realized_performance",
        confidence: "high",
      },
    });

    assert.equal(defensive.regime, "defensive");
    assert.equal(defensive.hysteresis_reason, "protective_immediate_switch");
  } finally {
    if (originalStateFile) process.env.ZENITH_REGIME_STATE_FILE = originalStateFile;
    else delete process.env.ZENITH_REGIME_STATE_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applyRegimeHysteresis decays stale pending regime proposals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-regime-hysteresis-decay-test-"));
  const originalStateFile = process.env.ZENITH_REGIME_STATE_FILE;

  try {
    process.env.ZENITH_REGIME_STATE_FILE = path.join(tempDir, "regime-state.json");
    const { applyRegimeHysteresis } = await import(`./regime-packs.js?test=${Date.now()}`);

    applyRegimeHysteresis({
      classification: { regime: "offensive", reason: "seed", confidence: "medium" },
      nowMs: 0,
    });
    applyRegimeHysteresis({
      classification: { regime: "neutral", reason: "default_baseline", confidence: "low" },
      nowMs: 60 * 60 * 1000,
    });
    const decayed = applyRegimeHysteresis({
      classification: { regime: "neutral", reason: "default_baseline", confidence: "low" },
      nowMs: 5 * 60 * 60 * 1000,
    });

    assert.equal(decayed.regime, "offensive");
    assert.equal(decayed.hysteresis_reason, "pending_signal_decayed");
    assert.equal(decayed.pending_hits, 1);
  } finally {
    if (originalStateFile) process.env.ZENITH_REGIME_STATE_FILE = originalStateFile;
    else delete process.env.ZENITH_REGIME_STATE_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
