# Zenith

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLM-guided runtime orchestration.**

---

## What it does

- **Screens pools** — continuously filters Meteora DLMM opportunities by fee/active-TVL, TVL, volume, organic score, holder count, market cap, bin step, and token-fee quality signals
- **Ranks candidates deterministically** — assigns auditable screening scores in code before the LLM reasons about the final deploy choice
- **Plans deployments deterministically** — uses `choose_distribution_strategy` and `calculate_dynamic_bin_tiers` to shape each deployment or rebalance before capital is placed
- **Scores LP wallets** — uses `score_top_lpers` to rank strong wallets for a pool, with optional enrichment when LP-agent scoring data is available
- **Manages positions actively** — monitors open positions, claims fees when justified, and rebalances out-of-range positions immediately when no higher-priority hard exit applies
- **Learns from memory** — stores wallet-score memory per pool plus distribution success-rate memory from closed positions so later cycles can reuse what worked
- **Runs as an operator-facing agent** — supports REPL and Telegram workflows for autonomous cycles, manual actions, and live status checks

---

## How it works

Zenith runs a ReAct-style agent loop on top of a deterministic runtime. The LLM still reasons about what to do next, but the runtime now owns more of the control plane: candidate ranking, hard screening gates, cycle evaluation records, tool-outcome tracking, and same-cycle write de-duplication.

Two specialized agents run on independent schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Hunter Alpha** | Every 30 min | Screening and deployment into the best current candidate |
| **Healer Alpha** | Every 3 min | Position management, fee handling, and rebalance/exit decisions |

A third health check runs hourly to summarize portfolio state.

**Current runtime behavior:**
- Screening cycles rank candidates in code first, then preload LP-wallet scoring and planner context for the strongest finalists instead of refetching `score_top_lpers`, `choose_distribution_strategy`, or `calculate_dynamic_bin_tiers` blindly
- Management cycles prefer `rebalance_on_exit` immediately when a position is out of range and no higher-priority stop-loss / trailing-take-profit / instruction-driven exit already fired
- Management cadence is runtime-owned and auto-adjusts from the most volatile open position: `>= 5 -> 3m`, `>= 2 -> 5m`, otherwise `10m`
- Fee handling prefers `auto_compound_fees` in safe mode with `execute_reinvest=false`; this claims fees and returns a reinvest plan, but does **not** perform true in-place compounding
- Runtime protections prevent duplicate close/claim/rebalance/compound actions for the same position within the same cycle
- Screening prompts are intentionally slimmer: deterministic control signals stay visible, but narrative and memory context are truncated so the model sees less noise

**Data sources used by the agent:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close flows
- Meteora DLMM PnL API — position yield, fee accrual, and PnL context
- Wallet RPC — SOL and token balances
- Pool screening + wallet-quality inputs — pool metrics, token holder checks, smart-wallet checks, and optional LP-agent enrichment for top-LPer scoring

Agents are powered via OpenRouter-compatible models and can be swapped by changing `managementModel`, `screeningModel`, and `generalModel` in `user-config.json`.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Telegram bot token (optional, for notifications)
- `LPAGENT_API_KEY` (optional, enables `score_top_lpers` / top-LPer scoring features when available)

---

## Setup

**1. Clone the repo**

```bash
git clone <repo-url>
cd Zenith
```

**2. Install dependencies**

```bash
npm install
```

**3. Create `.env`**

```env
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=your_base58_private_key
HELIUS_API_KEY=your_helius_key         # optional for some wallet/balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...       # optional
LPAGENT_API_KEY=lpagent_...            # optional, enables score_top_lpers when available
DRY_RUN=true                           # safest way to start
```

> **RPC**: defaults to `https://pump.helius-rpc.com` if you do not override it. You can set `RPC_URL=` in `.env` or `rpcUrl` in `user-config.json`.

**4. Create `user-config.json`**

Use the interactive setup:

```bash
npm run setup
```

Or copy `user-config.example.json` to `user-config.json` and edit it manually.

**5. Run**

```bash
npm run dev    # dry run; no live on-chain transactions
npm start      # live mode
```

On startup Zenith loads wallet state, open positions, and current candidates, then starts the autonomous screening and management cycles.

---

## Config reference

Edit `user-config.json`. The example file is a starting point; the runtime defaults below reflect the current code path.

| Field | Default | Description |
|---|---|---|
| `walletKey` | — | Base58-encoded private key of the trading wallet |
| `rpcUrl` | — | Solana RPC endpoint URL |
| `dryRun` | `true` | Simulate transactions without submitting them |
| `deployAmountSol` | `0.5` | Minimum deploy floor used by the sizing logic |
| `positionSizePct` | `0.35` | Fraction of deployable SOL used when wallet-based sizing scales upward |
| `gasReserve` | `0.2` | SOL kept back from deployment sizing |
| `maxDeployAmount` | `50` | Maximum deploy size cap |
| `maxPositions` | `3` | Maximum concurrent open positions |
| `minSolToOpen` | `0.55` | Minimum SOL balance before opening a new position |
| `managementIntervalMin` | `3` | Default management cadence |
| `screeningIntervalMin` | `30` | Default screening cadence |
| `healthCheckIntervalMin` | `60` | Default health-summary cadence |
| `managementModel` | `openrouter/healer-alpha` | LLM model for position management |
| `screeningModel` | `openrouter/hunter-alpha` | LLM model for pool screening |
| `generalModel` | `openrouter/healer-alpha` | LLM model for REPL chat and general prompts |
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL in USD |
| `maxTvl` | `150000` | Maximum pool TVL in USD |
| `minVolume` | `500` | Minimum pool volume threshold |
| `minOrganic` | `60` | Minimum organic score |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap |
| `maxMcap` | `10000000` | Maximum market cap |
| `minBinStep` | `80` | Minimum supported bin step |
| `maxBinStep` | `125` | Maximum supported bin step |
| `timeframe` | `5m` | Screening timeframe |
| `category` | `trending` | Pool category filter |
| `takeProfitFeePct` | `5` | Close when fees reach this percent of deployed capital |
| `minClaimAmount` | `5` | Fee threshold for claim / safe-mode compounding |
| `outOfRangeWaitMinutes` | `30` | Recorded out-of-range timing window and alert context; runtime management cadence is now enforced from live open-position volatility |
| `minVolumeToRebalance` | `1000` | Minimum pool volume needed for rebalance logic |
| `maxBundlersPct` | `30` | Maximum allowed bundler concentration across top-100 holders |
| `maxTop10Pct` | `60` | Maximum allowed top-10 real-holder concentration |

---

## REPL commands

After startup, an interactive prompt is available. The prompt shows a live countdown to the next management and screening cycle.

```
[manage: 2m 41s | screen: 24m 3s]
>
```

| Command | Description |
|---|---|
| `1`, `2`, `3` ... | Deploy into that numbered pool from the current candidate list |
| `auto` | Let the agent pick the best pool and deploy automatically |
| `/status` | Refresh and display wallet balance and open positions |
| `/candidates` | Re-screen and display the current top candidates |
| `/learn` | Study top LPers across current candidate pools and save lessons |
| `/learn <pool_address>` | Study top LPers for one specific pool |
| `<wallet_address>` | Inspect a wallet's positions or a pool's LP-wallet context |
| `/thresholds` | Show current screening thresholds and closed-position performance stats |
| `/evolve` | Trigger threshold evolution from performance data |
| `/stop` | Graceful shutdown |
| `<anything else>` | Free-form chat for questions, actions, and pool analysis |

Free-form chat keeps recent session history so you can continue the conversation naturally.

---

## Telegram

**Setup:**

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Start the agent, then send any message to the bot

On first message, Zenith auto-registers your chat ID and starts sending notifications.

**Notifications include:**
- Management-cycle reports
- Screening-cycle reports
- Out-of-range position alerts and follow-up actions
- Deploy confirmations
- Close confirmations and realized PnL context

Telegram uses the same free-form agent interface as the REPL.

---

## Memory and learning

Zenith stores structured knowledge in local memory files and reuses it in later cycles.

### LP-wallet score memory

When `score_top_lpers` runs, the agent stores wallet-score memory keyed to the pool. That memory keeps the top scored wallets, score breakdowns, and whether optional enrichment was available, so later cycles can reuse the prior ranking instead of paying for repeated lookups. Wallet-score memory also carries freshness metadata so runtime can reuse it conservatively instead of treating old scores as evergreen truth.

### Distribution success-rate memory

When positions close, Zenith records distribution success-rate memory by distribution key. This tracks win rate, average PnL, average fee yield, hold time, recent pools, and strategy-level outcomes so the agent can reason from prior distribution performance.

### Broader strategy memory

Strategy memory no longer depends only on exact `strategy + bin step` pairings. Zenith now stores broader reusable strategy buckets (for example tight / standard / wide bin-step groups) so lessons transfer more safely without exploding prompt size or overfitting to exact historical settings.

### Lessons, thresholds, and evaluation

`/learn` still supports deeper top-LPer study for qualitative lessons, while `/evolve` updates screening thresholds from closed-position history. Those lessons and evolved thresholds are fed back into future cycles without requiring a restart.

Zenith now also keeps bounded evaluation summaries in local state: recent management/screening cycles, recent tool outcomes, and compact counters such as candidates scored, candidates blocked, runtime actions handled, and write-tool blocks/errors. These are meant for operator visibility and auditability, not as a second hidden strategy engine.

### Candidate quality gates

Holder-quality checks now rely on stronger signals such as `common_funder` and `funded_same_window`. The older `similar_amount` heuristic was removed because it over-flagged legitimate small holders at top-100 scale.

---

## Compounding caveat

Compounding is currently **safe-mode claim/planning**, not true in-place compounding.

- `auto_compound_fees` can claim fees and produce a deterministic reinvestment plan
- The planner still uses `choose_distribution_strategy` and `calculate_dynamic_bin_tiers`
- The current runtime intentionally blocks duplicate same-pool deployment and does not claim that an in-place compound happened when it did not

Treat the compounding output as a claim plus a suggested next action, not as a completed in-position reinvest.

---

## Hive Mind (optional)

Meridian includes an **opt-in** collective intelligence system called **Hive Mind**. When enabled, your agent anonymously shares what it learns (lessons, deploy outcomes, screening thresholds) with other meridian agents and receives crowd wisdom in return.

**What you get:**
- Pool consensus from other agents — "8 agents deployed here, 72% win rate"
- Strategy rankings — which strategies actually work across all agents
- Pattern consensus — what works at different volatility levels
- Threshold medians — what screening settings other agents have evolved to

**What you share:**
- Lessons from `lessons.json`
- Deploy outcomes from `pool-memory.json` (pool address, strategy, PnL, hold time)
- Screening thresholds from `user-config.json`
- **NO wallet addresses, private keys, or SOL balances are ever sent**

**Impact:** 1 non-blocking API call per screening cycle (~200ms), 1 fire-and-forget POST on position close. If the hive is down, your agent doesn't notice.

### Setup

**1. Get the registration token** from the private Telegram discussion.

**2. Register your agent**

```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

Replace `YOUR_TOKEN` with the registration token from Telegram.

This automatically saves your credentials to `user-config.json`. **Save the API key printed in the terminal** — it will not be shown again.

**3. Done.** No restart needed. Your agent will sync on every position close and query the hive during screening.

### Disable

Clear both fields in `user-config.json`:
```json
{
  "hiveMindUrl": "",
  "hiveMindApiKey": ""
}
```

### Self-hosting

You can run your own hive server instead of using the public one. See [meridian-hive](https://github.com/fciaf420/meridian-hive) for the server source code.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk and can lose funds. Start with `npm run dev`, verify the agent behavior in dry run, and never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for losses incurred through use of this software.
