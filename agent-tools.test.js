import assert from "node:assert/strict";
import test from "node:test";

test("general role is read-only unless dangerous tools are explicitly allowed", async () => {
	process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
	const { getToolsForRole, limitToolCallsPerTurn } = await import("./agent.js");
	const generalSafe = getToolsForRole("GENERAL").map((tool) => tool.function.name);
	assert.equal(generalSafe.includes("get_top_candidates"), true);
	assert.equal(generalSafe.includes("deploy_position"), false);
	assert.equal(generalSafe.includes("close_position"), false);
	assert.equal(generalSafe.includes("update_config"), false);
	assert.equal(generalSafe.includes("add_lesson"), false);

	const generalArmed = getToolsForRole("GENERAL", { allowDangerousTools: true }).map((tool) => tool.function.name);
	assert.equal(generalArmed.includes("deploy_position"), false);
	assert.equal(generalArmed.includes("update_config"), false);
	assert.equal(generalArmed.includes("self_update"), false);

	const screenerTools = getToolsForRole("SCREENER").map((tool) => tool.function.name);
	const managerTools = getToolsForRole("MANAGER").map((tool) => tool.function.name);
	assert.equal(screenerTools.includes("update_config"), false);
	assert.equal(managerTools.includes("update_config"), false);
	assert.equal(screenerTools.includes("remember_fact"), false);
	assert.equal(managerTools.includes("remember_fact"), false);
	assert.equal(screenerTools.includes("add_pool_note"), false);
	assert.equal(managerTools.includes("set_position_note"), false);
	assert.equal(screenerTools.includes("recall_memory"), false);
	assert.equal(managerTools.includes("recall_memory"), false);
	assert.equal(screenerTools.includes("get_wallet_balance"), true);
	assert.equal(managerTools.includes("get_my_positions"), true);

	const generalScoped = getToolsForRole("GENERAL", {
		allowDangerousTools: true,
		dangerousToolScope: { allowed_tools: ["deploy_position"] },
	}).map((tool) => tool.function.name);
	assert.equal(generalScoped.includes("deploy_position"), true);
	assert.equal(generalScoped.includes("close_position"), false);
	assert.equal(generalScoped.includes("swap_token"), false);

	const limited = limitToolCallsPerTurn([
		{ id: "call-1", function: { name: "get_top_candidates", arguments: "{}" } },
		{ id: "call-2", function: { name: "deploy_position", arguments: "{}" } },
	]);
	assert.equal(limited.length, 1);
	assert.equal(limited[0].id, "call-1");
});

test("manager and screener can disable live state read tools when running from pre-loaded snapshots", async () => {
	process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
	const { getToolsForRole } = await import("./agent.js");

	const restrictedManagerTools = getToolsForRole("MANAGER", { disableLiveStateTools: true }).map((tool) => tool.function.name);
	const restrictedScreenerTools = getToolsForRole("SCREENER", { disableLiveStateTools: true }).map((tool) => tool.function.name);

	assert.equal(restrictedManagerTools.includes("get_my_positions"), false);
	assert.equal(restrictedManagerTools.includes("get_position_pnl"), false);
	assert.equal(restrictedManagerTools.includes("get_wallet_balance"), false);
	assert.equal(restrictedManagerTools.includes("close_position"), true);

	assert.equal(restrictedScreenerTools.includes("get_top_candidates"), false);
	assert.equal(restrictedScreenerTools.includes("get_my_positions"), false);
	assert.equal(restrictedScreenerTools.includes("get_wallet_balance"), false);
	assert.equal(restrictedScreenerTools.includes("deploy_position"), true);
});

test("isTransientProviderError recognizes transient provider failures", async () => {
	process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
	const { isTransientProviderError } = await import("./agent.js");

	assert.equal(isTransientProviderError({ status: 503, message: "service unavailable" }), true);
	assert.equal(isTransientProviderError(new Error("network timeout while calling provider")), true);
	assert.equal(isTransientProviderError(new Error("invalid request payload")), false);
});

test("agentLoop retries thrown transient provider failures", async () => {
	process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
	const { agentLoop } = await import("./agent.js");
	let calls = 0;

	const result = await agentLoop("Say ok", 2, [], "GENERAL", "test-model", 128, {
		stateSnapshot: {
			portfolio: { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0 },
			positions: { wallet: null, total_positions: 0, positions: [] },
		},
		llmClient: {
			chat: {
				completions: {
					create: async () => {
						calls += 1;
						if (calls === 1) {
							const error = new Error("service unavailable");
							error.status = 503;
							throw error;
						}
						return {
							choices: [{ message: { role: "assistant", content: "ok" } }],
						};
					},
				},
			},
		},
	});

	assert.equal(calls, 2);
	assert.equal(result.content, "ok");
});

test("agentLoop reports invalid tool arguments without executing the tool", async () => {
	process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
	const { agentLoop } = await import("./agent.js");
	const requests = [];
	let executeToolCalls = 0;

	const result = await agentLoop("Use a tool", 3, [], "GENERAL", "test-model", 128, {
		stateSnapshot: {
			portfolio: { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0 },
			positions: { wallet: null, total_positions: 0, positions: [] },
		},
		llmClient: {
			chat: {
				completions: {
					create: async (request) => {
						requests.push(request);
						if (requests.length === 1) {
							return {
								choices: [{
									message: {
										role: "assistant",
										content: null,
										tool_calls: [{
											id: "call-1",
											function: {
												name: "get_wallet_balance",
												arguments: "{invalid-json",
											},
										}],
									},
								}],
							};
						}
						return {
							choices: [{ message: { role: "assistant", content: "tool parse handled" } }],
						};
					},
				},
			},
		},
		executeTool: async () => {
			executeToolCalls += 1;
			return { success: true };
		},
	});

	assert.equal(executeToolCalls, 0);
	assert.equal(result.content, "tool parse handled");
	const toolErrorMessage = requests[1].messages.find((message) => message.role === "tool");
	assert.match(toolErrorMessage.content, /Invalid tool arguments/);
});
