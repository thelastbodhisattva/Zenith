import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { createActionId } from "./cycle-trace.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "rebalance_on_exit", "auto_compound_fees", "swap_token", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance", "get_pool_info", "score_top_lpers", "choose_distribution_strategy", "calculate_dynamic_bin_tiers", "remember_fact", "recall_memory"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "get_wallet_balance", "get_my_positions", "get_pool_info", "score_top_lpers", "choose_distribution_strategy", "calculate_dynamic_bin_tiers", "remember_fact", "recall_memory"]);
const GENERAL_SAFE_TOOLS = new Set([
  "discover_pools",
  "get_top_candidates",
  "get_pool_detail",
  "get_position_pnl",
  "get_active_bin",
  "choose_distribution_strategy",
  "calculate_dynamic_bin_tiers",
  "get_my_positions",
  "get_wallet_positions",
  "search_pools",
  "get_token_info",
  "get_token_holders",
  "get_token_narrative",
  "list_smart_wallets",
  "check_smart_wallets_on_pool",
  "get_wallet_balance",
  "get_top_lpers",
  "study_top_lpers",
  "score_top_lpers",
  "get_pool_info",
  "get_performance_history",
  "list_strategies",
  "get_strategy",
  "get_pool_memory",
  "list_lessons",
  "recall_memory",
  "list_blacklist",
]);

export function getToolsForRole(agentType, { allowDangerousTools = false, dangerousToolScope = null } = {}) {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  if (allowDangerousTools) {
		const allowedScopedTools = new Set(
			Array.isArray(dangerousToolScope?.allowed_tools)
				? dangerousToolScope.allowed_tools
				: [],
		);
		return tools.filter((tool) => {
			const name = tool.function.name;
			if (name === "self_update") return false;
			if (GENERAL_SAFE_TOOLS.has(name)) return true;
			if (allowedScopedTools.size === 0) return false;
			return allowedScopedTools.has(name);
		});
	}
  return tools.filter((t) => GENERAL_SAFE_TOOLS.has(t.function.name));
}

export function limitToolCallsPerTurn(toolCalls = []) {
  return Array.isArray(toolCalls) && toolCalls.length > 0 ? [toolCalls[0]] : [];
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getMemoryContext } from "./memory.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const memoryContext = getMemoryContext();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, memoryContext);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,          // inject prior conversation turns
    { role: "user", content: goal },
  ];
  let toolActionIndex = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await client.chat.completions.create({
          model: usedModel,
          messages,
          tools: getToolsForRole(agentType, options),
          tool_choice: "auto",
          temperature: config.llm.temperature,
          max_tokens: maxOutputTokens ?? config.llm.maxTokens,
        });
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      const immediateToolCalls = limitToolCallsPerTurn(msg.tool_calls);
      if (msg.tool_calls.length > immediateToolCalls.length) {
        log(
          "agent",
          `Deferring ${msg.tool_calls.length - immediateToolCalls.length} additional tool call(s) until the model sees the first tool result`,
        );
      }

      const toolCall = immediateToolCalls[0];
      const functionName = toolCall.function.name;
      let functionArgs;

      try {
        functionArgs = JSON.parse(toolCall.function.arguments);
      } catch (parseError) {
        log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
        functionArgs = {};
      }

      const toolMeta = {};
      if (options.toolContext?.cycle_id) {
        toolMeta.cycle_id = options.toolContext.cycle_id;
        toolMeta.cycle_type = options.toolContext.cycle_type || null;
        toolMeta.regime_label = options.toolContext.regime_label || null;
        toolMeta.action_id = createActionId(options.toolContext.cycle_id, functionName, toolActionIndex);
        toolActionIndex += 1;
      }

      const result = await executeTool(functionName, functionArgs, toolMeta);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
