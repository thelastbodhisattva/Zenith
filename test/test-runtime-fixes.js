import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAdaptiveDeployAmount,
  estimateInitialValueUsd,
  getEffectiveMinSolToOpen,
  getRequiredSolBalance,
  getScreeningThresholdSummary,
} from "../runtime-helpers.js";

test("effective min SOL always covers deploy amount plus gas reserve", () => {
  assert.equal(getRequiredSolBalance({ deployAmountSol: 0.5, gasReserve: 0.2 }), 0.7);
  assert.equal(
    getEffectiveMinSolToOpen({ minSolToOpen: 0.55, deployAmountSol: 0.5, gasReserve: 0.2 }),
    0.7,
  );
  assert.equal(
    getEffectiveMinSolToOpen({ minSolToOpen: 1.2, deployAmountSol: 0.5, gasReserve: 0.2 }),
    1.2,
  );
});

test("screening threshold summary uses canonical live keys", () => {
  const labels = getScreeningThresholdSummary({
    minFeeActiveTvlRatio: 0.05,
    minTokenFeesSol: 30,
    maxBundlersPct: 30,
    maxTop10Pct: 60,
    minOrganic: 60,
    minHolders: 500,
    minVolume: 500,
    minTokenAgeHours: null,
    maxTokenAgeHours: null,
    timeframe: "5m",
  }).map(([label]) => label);

  assert.deepEqual(labels, [
    "minFeeActiveTvlRatio",
    "minTokenFeesSol",
    "maxBundlersPct",
    "maxTop10Pct",
    "minOrganic",
    "minHolders",
    "minVolume",
    "minTokenAgeHours",
    "maxTokenAgeHours",
    "timeframe",
  ]);
});

test("initial deploy value estimate prefers SOL leg and falls back to token leg", () => {
  assert.equal(estimateInitialValueUsd({ amountSol: 0.5, solPrice: 120 }), 60);
  assert.equal(estimateInitialValueUsd({ amountSol: 0, amountToken: 1200, activePrice: 600, solPrice: 100 }), 200);
  assert.equal(estimateInitialValueUsd({ amountSol: 0, amountToken: 1200, activePrice: 0, solPrice: 100 }), 0);
});

test("adaptive deploy sizing preserves reserve/floor/cap invariants", () => {
  const sized = computeAdaptiveDeployAmount({
    walletSol: 3,
    reserve: 0.2,
    floor: 0.5,
    ceil: 1.5,
    positionSizePct: 0.35,
    regimeMultiplier: 1.2,
    performanceMultiplier: 1,
    riskMultiplier: 1,
  });
  assert.equal(sized, 1.18);

  const capped = computeAdaptiveDeployAmount({
    walletSol: 100,
    reserve: 0.2,
    floor: 0.5,
    ceil: 2,
    positionSizePct: 0.5,
    regimeMultiplier: 1.2,
    performanceMultiplier: 1.1,
    riskMultiplier: 1,
  });
  assert.equal(capped, 2);

  const skipped = computeAdaptiveDeployAmount({
    walletSol: 0.62,
    reserve: 0.2,
    floor: 0.5,
    ceil: 2,
    positionSizePct: 0.35,
    skipBelowFloor: true,
  });
  assert.equal(skipped, 0);
});
