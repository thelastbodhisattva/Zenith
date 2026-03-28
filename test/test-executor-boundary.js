import assert from "node:assert/strict";

import { armGeneralWriteTools, disarmGeneralWriteTools } from "../operator-controls.js";
import { updateRuntimeHealth } from "../runtime-health.js";
import {
  executeTool,
  resetExecutorTestOverrides,
  runSafetyChecks,
  setExecutorTestOverrides,
} from "../tools/executor.js";

async function main() {
	setExecutorTestOverrides({
		getMyPositions: async () => ({
			total_positions: 1,
			positions: [{ position: "pos-1", pool: "pool-1", base_mint: "mint-a" }],
		}),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-b", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
  let result = await runSafetyChecks("deploy_position", {
    pool_address: "pool-1",
    amount_y: 0.5,
    base_mint: "mint-b",
    bin_step: 100,
  }, { cycle_id: "screening-test" });
  assert.equal(result.pass, false);
  assert.match(result.reason, /already have an open position in pool/i);

	setExecutorTestOverrides({
		getMyPositions: async () => ({
			total_positions: 1,
			positions: [{ position: "pos-1", pool: "pool-1", base_mint: "mint-a" }],
		}),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-a", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
  result = await runSafetyChecks("deploy_position", {
    pool_address: "pool-2",
    amount_y: 0.5,
    base_mint: "mint-a",
    bin_step: 100,
  }, { cycle_id: "screening-test" });
  assert.equal(result.pass, false);
  assert.match(result.reason, /already holding base token/i);

	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-c", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 0.55 }),
	});
	result = await runSafetyChecks("deploy_position", {
		pool_address: "pool-3",
		amount_y: 0.5,
		base_mint: "mint-c",
		bin_step: 100,
	}, { cycle_id: "screening-test" });
	assert.equal(result.pass, false);
	assert.match(result.reason, /insufficient sol/i);

	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-meta", bin_step: 101 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
	const deployArgs = {
		pool_address: "pool-meta",
		amount_y: 0.5,
	};
	result = await runSafetyChecks("deploy_position", deployArgs, { cycle_id: "screening-test" });
	assert.equal(result.pass, true);
	assert.equal(deployArgs.base_mint, "mint-meta");
	assert.equal(deployArgs.bin_step, 101);

	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-runtime", bin_step: 111 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
	const spoofedArgs = {
		pool_address: "pool-meta-override",
		amount_y: 0.5,
		base_mint: "mint-spoofed",
		bin_step: 999,
	};
	result = await runSafetyChecks("deploy_position", spoofedArgs, { cycle_id: "screening-test" });
	assert.equal(result.pass, true);
	assert.equal(spoofedArgs.base_mint, "mint-runtime");
	assert.equal(spoofedArgs.bin_step, 111);

  setExecutorTestOverrides({
    getMyPositions: async () => ({ total_positions: 0, positions: [] }),
  });
  result = await runSafetyChecks("close_position", {
    position_address: "missing-position",
  }, { cycle_id: "management-test" });
  assert.equal(result.pass, false);
  assert.match(result.reason, /not currently open/i);

	let updateConfigCalled = false;
	setExecutorTestOverrides({
		tools: {
			update_config: async () => {
				updateConfigCalled = true;
				return { success: true };
			},
		},
	});
	result = await executeTool("update_config", {
		changes: { minOrganic: 75 },
		reason: "test",
	});
	assert.equal(result.blocked, true);
	assert.equal(updateConfigCalled, false);

  let receivedArgs = null;
	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-d", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10, sol_price: 120, tokens: [] }),
		recordToolOutcome: () => {},
    tools: {
      deploy_position: async (args) => {
        receivedArgs = args;
        return { success: true, position: "pos-x", txs: ["tx-1"] };
      },
    },
  });
  result = await executeTool("deploy_position", {
    pool_address: "pool-4",
    amount_y: 0.5,
    base_mint: "mint-d",
    bin_step: 100,
    initial_value_usd: 1,
  }, { cycle_id: "screening-test" });
  assert.equal(result.success, true);
  assert.ok(receivedArgs);
  assert.equal(receivedArgs.initial_value_usd, 60);

  const outcomes = [];
	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-e", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 0.4 }),
		recordToolOutcome: (payload) => outcomes.push(payload),
	});
  result = await executeTool("deploy_position", {
    pool_address: "pool-5",
    amount_y: 0.5,
    base_mint: "mint-e",
    bin_step: 100,
  });
  assert.equal(result.blocked, true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].tool, "deploy_position");
  assert.equal(outcomes[0].outcome, "blocked");

	armGeneralWriteTools({
		minutes: 5,
		reason: "test scope",
		scope: {
			allowed_tools: ["deploy_position"],
			pool_address: "pool-preflight",
			max_amount_sol: 0.5,
			one_shot: true,
		},
	});
	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-preflight", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
	updateRuntimeHealth({ preflight: null });
	result = await runSafetyChecks("deploy_position", {
		pool_address: "pool-preflight",
		amount_y: 0.5,
	}, {});
	assert.equal(result.pass, false);
	assert.match(result.reason, /run \/preflight first/i);

	setExecutorTestOverrides({
		getMyPositions: async () => ({ error: "positions unavailable", positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-preflight", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
	result = await runSafetyChecks("deploy_position", {
		pool_address: "pool-preflight",
		amount_y: 0.5,
	}, { cycle_id: "screening-test" });
	assert.equal(result.pass, false);
	assert.match(result.reason, /unable to verify open positions/i);

	disarmGeneralWriteTools({ reason: "reset scope for manual preflight test" });
	armGeneralWriteTools({
		minutes: 5,
		reason: "test scope reset",
		scope: {
			allowed_tools: ["deploy_position"],
			pool_address: "pool-preflight",
			max_amount_sol: 0.5,
			one_shot: true,
		},
	});
	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getPoolGovernanceMetadata: async () => ({ base_mint: "mint-preflight", bin_step: 100 }),
		getWalletBalances: async () => ({ sol: 10 }),
	});
	updateRuntimeHealth({
		preflight: {
			pass: true,
			valid_until: new Date(Date.now() + 5 * 60_000).toISOString(),
			action: {
				tool_name: "deploy_position",
				pool_address: "pool-preflight",
				amount_sol: 0.5,
			},
		},
	});
	result = await runSafetyChecks("deploy_position", {
		pool_address: "pool-preflight",
		amount_y: 0.5,
	}, {});
	assert.equal(result.pass, true);

	result = await runSafetyChecks("close_position", {
		position_address: "pos-1",
	}, {});
	assert.equal(result.pass, false);
	assert.match(result.reason, /does not include tool close_position/i);

	setExecutorTestOverrides({
		getMyPositions: async () => ({ total_positions: 1, positions: [{ position: "pos-guard", pool: "pool-guard", base_mint: "mint-guard" }] }),
	});
	result = await runSafetyChecks("rebalance_on_exit", {
		position_address: "pos-guard",
	}, { cycle_id: "management-test" });
	assert.equal(result.pass, true);

	disarmGeneralWriteTools({ reason: "test cleanup" });

  resetExecutorTestOverrides();
  console.log("executor boundary checks passed");
  process.exit(0);
}

main().catch((error) => {
  resetExecutorTestOverrides();
  console.error(error);
  process.exit(1);
});
