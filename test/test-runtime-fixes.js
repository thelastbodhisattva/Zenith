import assert from "node:assert/strict";
import test from "node:test";

import { getEffectiveMinSolToOpen, getRequiredSolBalance, getScreeningThresholdSummary } from "../runtime-helpers.js";

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
    "timeframe",
  ]);
});
