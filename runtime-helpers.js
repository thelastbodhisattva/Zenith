export function getRequiredSolBalance({ deployAmountSol = 0, gasReserve = 0 }) {
  const required = Number(deployAmountSol) + Number(gasReserve);
  return Number(required.toFixed(3));
}

export function getEffectiveMinSolToOpen({
  minSolToOpen = 0,
  deployAmountSol = 0,
  gasReserve = 0,
}) {
  return Math.max(Number(minSolToOpen) || 0, getRequiredSolBalance({ deployAmountSol, gasReserve }));
}

export function getScreeningThresholdSummary(screening) {
  return [
    ["minFeeActiveTvlRatio", screening.minFeeActiveTvlRatio],
    ["minTokenFeesSol", screening.minTokenFeesSol],
    ["maxBundlersPct", screening.maxBundlersPct],
    ["maxTop10Pct", screening.maxTop10Pct],
    ["minOrganic", screening.minOrganic],
    ["minHolders", screening.minHolders],
    ["minVolume", screening.minVolume],
    ["timeframe", screening.timeframe],
  ];
}
