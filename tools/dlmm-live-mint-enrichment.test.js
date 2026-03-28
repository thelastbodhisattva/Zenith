import assert from "node:assert/strict";
import test from "node:test";

import { getTopCandidates } from "./screening.js";

test("live base mint enrichment still blocks same-token screening candidates", async () => {
	const candidates = await getTopCandidates({
		pools: [
			{
				pool: "pool-candidate",
				name: "Candidate Pool",
				base: { mint: "mint-live" },
				bin_step: 100,
				organic_score: 80,
				fee_tvl_ratio: 0.08,
				liquidity: 40000,
				trade_volume_24h: 10000,
				holder_count: 1000,
				market_cap: 500000,
				price_change_pct: 4,
			},
		],
		getMyPositionsFn: async () => ({
			total_positions: 1,
			positions: [
				{
					position: "pos-live-1",
					pool: "pool-live-1",
					base_mint: "mint-live",
				},
			],
		}),
		screeningConfig: {
			minFeeActiveTvlRatio: 0.01,
			minTvl: 1,
			maxTvl: 1_000_000,
			minVolume: 1,
			minOrganic: 1,
			minHolders: 1,
			minMcap: 1,
			maxMcap: 1_000_000_000,
			minBinStep: 1,
			maxBinStep: 200,
		},
	});

	assert.equal(candidates.candidates.length, 0);
	assert.equal(candidates.blocked_summary.base_token_already_held, 1);
});
