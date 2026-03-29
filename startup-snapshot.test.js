import assert from "node:assert/strict";
import test from "node:test";

import { getStartupSnapshot, resetStartupSnapshotCache } from "./startup-snapshot.js";

test.afterEach(() => {
  resetStartupSnapshotCache();
});

test("startup snapshot caches successful fetches", async () => {
  let calls = 0;
  const deps = {
    getWalletBalances: async () => {
      calls += 1;
      return { sol: 1 };
    },
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
  };

  const first = await getStartupSnapshot({ ...deps, force: true });
  const second = await getStartupSnapshot(deps);

  assert.equal(calls, 1);
  assert.equal(first.wallet.sol, 1);
	assert.equal(second.wallet.sol, 1);
});

test("startup snapshot deduplicates concurrent reads while a fetch is inflight", async () => {
	let walletCalls = 0;
	let releaseFetch;
	const gate = new Promise((resolve) => {
		releaseFetch = resolve;
	});
	const deps = {
		getWalletBalances: async () => {
			walletCalls += 1;
			await gate;
			return { sol: 1 };
		},
		getMyPositions: async () => ({ positions: [], total_positions: 0 }),
		getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
	};

	const first = getStartupSnapshot(deps);
	const second = getStartupSnapshot(deps);
	releaseFetch();
	const [firstResult, secondResult] = await Promise.all([first, second]);

	assert.equal(walletCalls, 1);
	assert.equal(firstResult.wallet.sol, 1);
	assert.equal(secondResult.wallet.sol, 1);
});

test("startup snapshot fails closed on invalid payloads", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1 }),
    getMyPositions: async () => ({}),
    getTopCandidates: async () => ({ candidates: [] }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "STATE_INVALID");
});

test("startup snapshot fails closed on wallet error-shaped payload", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ error: "wallet RPC timeout" }),
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /wallet rpc timeout/i);
});

test("startup snapshot fails closed on stale provider payloads", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1, stale: true }),
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /stale/i);
});

test("startup snapshot fails closed on stale positions payload", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1 }),
    getMyPositions: async () => ({ positions: [], total_positions: 0, stale: true }),
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /positions stale/i);
});

test("startup snapshot fails closed on stale candidate payload metadata", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1 }),
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0, stale: true }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /candidates stale/i);
});

test("startup snapshot fails closed on partial candidate provider failure", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1 }),
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getTopCandidates: async () => ({
      candidates: [{ pool: "pool-1" }],
      error: "candidate API partial failure",
    }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /partial failure/i);
});

test("startup snapshot classifies thrown provider timeouts as input unavailable", async () => {
  const result = await getStartupSnapshot({
    force: true,
    getWalletBalances: async () => ({ sol: 1 }),
    getMyPositions: async () => {
      throw new Error("RPC timeout while fetching positions");
    },
    getTopCandidates: async () => ({ candidates: [], total_eligible: 0, total_screened: 0 }),
  });

  assert.equal(result.status, "fail_closed");
  assert.equal(result.reason_code, "INPUT_UNAVAILABLE");
  assert.match(result.message, /timeout/i);
});
