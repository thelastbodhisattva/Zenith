# Zenith

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLM-guided runtime orchestration.**

Implementation status updated: `2026-03-27`

---

## What it does

- **Screens pools** — continuously filters Meteora DLMM opportunities by fee/active-TVL, TVL, volume, organic score, holder count, market cap, bin step, and token-fee quality signals
- **Ranks candidates deterministically** — assigns auditable screening scores in code before the LLM reasons about the final deploy choice
- **Plans deployments deterministically** — uses `choose_distribution_strategy` and `calculate_dynamic_bin_tiers` to shape each deployment or rebalance before capital is placed
- **Scores LP wallets** — uses `score_top_lpers` to rank strong wallets for a pool, with optional enrichment when LP-agent scoring data is available
- **Manages positions actively** — monitors open positions, claims fees when justified, and rebalances out-of-range positions immediately when no higher-priority hard exit applies
- **Learns from memory** — stores wallet-score memory per pool plus distribution success-rate memory from closed positions so later cycles can reuse what worked
- **Runs as an operator-facing agent** — supports REPL and Telegram workflows for autonomous cycles, manual actions, and live status checks
- **Surfaces cached LP performance** — uses a cached LP Agent overview for briefings and operator reporting without feeding that data back into execution policy

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
- Screening cycles now use a staged funnel: cheap deterministic ranking across a wider candidate set, a visible ranked shortlist, and deep enrichment only for top finalists instead of enriching every candidate equally
- Management cycles now resolve obvious runtime actions first (stop-loss closes, take-profit closes, low-yield closes, fee-threshold handling, and out-of-range rebalances) and leave the LLM mainly with instruction-bound edge cases
- Management cadence is runtime-owned and auto-adjusts from the most volatile open position: `>= 5 -> 3m`, `>= 2 -> 5m`, otherwise `10m`
- Fee handling prefers `auto_compound_fees` in safe mode with `execute_reinvest=false`; this claims fees and returns a reinvest plan, but does **not** perform true in-place compounding
- Runtime protections prevent duplicate close/claim/rebalance/compound actions for the same position within the same cycle
- Screening prompts are intentionally slimmer: deterministic control signals stay visible, but narrative and memory context are truncated so the model sees less noise
- Closed-position learning now records inventory-vs-fee contribution and operational touch counts so later evaluation is less likely to confuse extra actions with better outcomes
- Threshold evolution now only mutates live screening keys that the runtime actually uses
- Operator reporting can now combine local realized attribution with cached LP-overview summaries, while keeping execution decisions runtime-owned
- Screening now has an exact pre-LLM skip for the real empty-shortlist case: if deterministic filters produce no eligible candidates, the cycle records `skipped_no_candidates` and does not invoke the model
- Startup, `/status`, and `/candidates` now reuse a short-lived startup snapshot instead of bursty repeated fetches
- Open-position state now tracks explicit out-of-range direction (`above` / `below`) for clearer operator reporting and postmortems
- Post-close handling now uses a bounded settlement check instead of a blind fixed sleep, reducing stale-balance races after close transactions
- `deploy_position` no longer depends on redundant `get_active_bin` choreography and now backfills deploy-time USD basis data when only the SOL leg is known
- Setup input now masks wallet private key entry instead of echoing secrets in plain text
- Phase 0 serious-capital work is now in place: executor-boundary contract checks, cycle/action correlation IDs, replay envelopes for screening and management, fail-closed startup/screening behavior, and deterministic reconciliation helpers
- Startup snapshot caching/validation and deterministic management-runtime execution are now extracted into dedicated helpers so the orchestration path is easier to prove and test
- Bad-cycle evidence bundles are now persisted for fail-closed and failed screening/management cycles, and `/failures` exposes the latest bundle summaries directly in the REPL
- `/proof` now surfaces a bounded strategy-proof summary from realized closes: inventory contribution, fee contribution, operational touch count, per-strategy breakdown, and dominant close reasons
- Runtime writes now flow through a durable action journal in `data/workflow-actions.jsonl`, with executor-boundary `intent -> terminal` lifecycle tracking and rebalance-specific mid-state handoff for restart safety
- Boot recovery now resolves prior write workflows observation-first, blocks autonomous writes on journal corruption or unresolved outcomes, and exposes `/recovery` so the operator can inspect suppression state without opening JSONL directly
- Provider-free operator and chaos drills now cover fail-closed screening startup paths, stale-PnL management behavior, bounded LP Agent fallback, and screening replay reconciliation
- `npm run test:hardening` now acts as the committed runtime-hardening verification gate; `npm run test:screen` remains the live external screening smoke and `npm run test:agent` remains the optional dry-run full-agent smoke
- Autonomous screening now respects portfolio-level kill-switches based on recent realized loss and stop-loss streaks, pausing new capital deployment without disabling protective management flows
- The operator surface now includes runbook-grade commands for `/health`, `/journal`, `/failure <id>`, `/replay <cycle_id>`, `/reconcile <cycle_id>`, `/review`, `/resume <why>`, `/arm`, and `/disarm`
- General free-form chat is now read-only by default; write-capable GENERAL tool access must be explicitly armed for a bounded window, while deterministic screening/management flows keep their existing runtime-owned privileges
- Zenith now writes a machine-readable heartbeat to `data/runtime-health.json`, tracking startup status, cycle status, suppression state, provider health, and write-arming state for external checks
- Setup writes `WALLET_PRIVATE_KEY` to `.env` and Zenith reads wallet secrets from environment only
- Screening now applies fixed regime-conditioned parameter packs (`defensive` / `neutral` / `offensive`) deterministically, without mutating global config or letting the model invent new policy
- Regime switching now uses bounded hysteresis with confirmation, active dwell time, and stale-pending decay so Zenith does not flap between packs on marginal inputs
- Threshold evolution is now rollout-based with automatic accept/rollback, so a bad auto-tune can revert instead of ratcheting forever
- Deploy sizing now adapts under hard caps using regime, recent realized performance, and position-utilization context, while still respecting reserve/floor/ceiling rules
- Negative memory now includes cross-pool regime cooldowns with sample-quality gating, and screening also records observational counterfactual review for alternate regime packs without executing them

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
- `JUPITER_API_KEY` (optional, used for authenticated Jupiter swap/quote requests when available)

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
JUPITER_API_KEY=jup_...                # optional, adds authenticated Jupiter API access when available
DRY_RUN=true                           # safest way to start
```

> **RPC**: defaults to `https://pump.helius-rpc.com` if you do not override it. You can set `RPC_URL=` in `.env` or `rpcUrl` in `user-config.json`.

**4. Create `user-config.json`**

Use the interactive setup:

```bash
npm run setup
```

Or copy `user-config.example.json` to `user-config.json` and edit it manually.

`user-config.json` is for runtime settings only. Keep wallet secrets in `.env`; setup now writes `WALLET_PRIVATE_KEY` there instead of persisting it in `user-config.json`.

**5. Run**

```bash
npm run dev    # dry run; no live on-chain transactions
npm start      # live mode
npm run test:hardening  # deterministic runtime-hardening verification gate
```

On startup Zenith loads wallet state, open positions, and current candidates, then starts the autonomous screening and management cycles.

---

## Config reference

Edit `user-config.json`. The example file is a starting point; the runtime defaults below reflect the current code path.

| Field | Default | Description |
|---|---|---|
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
| `protectionsEnabled` | `true` | Enable portfolio-level autonomous trading pauses |
| `maxRecentRealizedLossUsd` | `100` | Pause new autonomous capital deployment if recent realized losses exceed this USD amount |
| `maxDrawdownPct` | `25` | Pause new autonomous capital deployment if portfolio equity drawdown exceeds this percentage |
| `maxOpenUnrealizedLossUsd` | `150` | Pause new autonomous capital deployment if aggregate open-position unrealized loss exceeds this USD amount |
| `recentLossWindowHours` | `24` | Lookback window for realized-loss protection |
| `stopLossStreakLimit` | `3` | Pause new autonomous capital deployment after this many consecutive stop-loss closes |
| `portfolioPauseMinutes` | `180` | Duration of a portfolio-guard pause once triggered |
| `recoveryResumeOverrideMinutes` | `180` | Duration of a persisted operator recovery-resume override window |
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
| `/candidate <n>` | Inspect one ranked candidate with richer signals on demand |
| `/health` | Show machine-readable heartbeat, provider health, suppression state, and guard status |
| `/evaluation` | Show recent cycle/tool evaluation summaries |
| `/failures` | Show recent persisted bad-cycle evidence bundles |
| `/failure <id>` | Show one persisted evidence bundle in detail |
| `/recovery` | Show recovery suppression state and unresolved/manual-review workflows |
| `/journal` | Show recent write-workflow journal entries |
| `/replay <cycle_id>` | Show one replay envelope |
| `/reconcile <cycle_id>` | Re-run deterministic replay reconciliation for one cycle |
| `/review` | Show replay-backed review stats across recent cycles |
| `/resume <why>` | Clear current-process autonomous write suppression after manual review |
| `/arm [minutes] [why]` | Temporarily arm GENERAL free-form write tools |
| `/disarm` | Remove GENERAL free-form write access |
| `/performance` | Show recent closed-position attribution and history |
| `/proof` | Show bounded strategy proof summary from realized closes |
| `/briefing` | Show a daily briefing that now prefers cached LP-overview metrics when available |
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

Threshold evolution is now bounded as a rollout instead of a blind overwrite:

- Zenith stores the previous and new threshold values in `threshold-rollout.json`
- after the minimum number of subsequent closes, Zenith either accepts the rollout or rolls it back automatically if post-change performance degrades
- this keeps evolution online and autonomous without letting one bad step permanently distort screening

Zenith now also keeps bounded evaluation summaries in local state: recent management/screening cycles, recent tool outcomes, and compact counters such as candidates scored, candidates blocked, runtime actions handled, and write-tool blocks/errors. These are meant for operator visibility and auditability, not as a second hidden strategy engine.

Management runtime actions also expose explicit subreason codes (for example stop loss, take profit, low fee yield, fee threshold, or out-of-range rebalance) so operator-facing reports and tests can describe *why* runtime acted without widening prompt-owned policy.

### Phase 0 proof surfaces

Zenith now has a minimal proof layer for serious-capital safety work:

- executor-boundary contract checks for the write blast wall (`test/test-executor-boundary.js`)
- cycle/action correlation IDs threaded through runtime actions and evaluation state
- replay envelopes for screening and management cycles (`cycle-trace.js`)
- provider-free deterministic replay helpers (`cycle-replay.js`)
- fail-closed degraded-mode contracts with explicit reason codes (`degraded-mode.js`)
- minimal reconciliation helpers for replay-vs-recorded deterministic behavior (`reconciliation.js`)

This is intentionally narrow. It is not a full analytics platform or event system — just enough structure to prove and inspect deterministic behavior at the control-plane boundary.

### Phase 1-3 bounded proof surfaces

Zenith now also includes a small set of proof-oriented but still lean operator/runtime modules:

- `startup-snapshot.js` — short-lived cached startup/operator snapshot with fail-closed validation
- `management-runtime.js` — separately testable deterministic runtime action runner for obvious management actions
- `evidence-bundles.js` — persisted bad-cycle evidence summaries for postmortem review
- `getStrategyProofSummary()` in `lessons.js` — bounded realized proof summary instead of a new strategy engine

### Phase 4 runtime-hardening surfaces

Zenith now closes the next serious-capital layer with explicit restart and recovery surfaces:

- `action-journal.js` — append-only workflow ledger for autonomous write intents and terminal states
- `boot-recovery.js` — observation-first startup recovery, journal corruption blocking, and `/recovery` operator reporting
- `runtime-hardening-plan.md` — committed file map for the action ledger, recovery, fault-injection seams, and reconciliation layer
- `runtime-hardening-review.md` — committed anti-bloat and hidden-failure review note for this runtime-hardening phase

### Phase 5 elite ops surfaces

Zenith now adds a thin elite-ops layer on top of runtime hardening:

- `portfolio-guards.js` — portfolio-level autonomous trading pauses for stop-loss streaks and realized-loss windows
- `runtime-health.js` — machine-readable heartbeat and provider-health state in `data/runtime-health.json`
- `replay-review.js` — operator-friendly replay lookup and reconciliation review over persisted envelopes
- `operator-controls.js` — bounded GENERAL write arming plus durable, restart-aware operator resume actions
- `management-cycle-runner.js` / `screening-cycle-runner.js` — extracted autonomous cycle runners so `index.js` stays focused on boot and wiring
- `interactive-interface.js` / `startup-interface.js` — extracted REPL, Telegram, and startup surfaces so operator flow is no longer embedded directly in `index.js`

### Phase 6 bounded adaptation surfaces

Zenith now adds a constrained adaptation layer rather than open-ended self-training:

- `regime-packs.js` — fixed regime classification and parameter-pack overlays for screening and sizing
- `negative-regime-memory.js` — cross-pool cooldown memory for repeatedly bad regime/strategy combinations
- `counterfactual-review.js` — observational-only records of what alternate regime packs would have selected, later linked to realized active outcomes for review usefulness
- `lessons.js` rollout state — threshold evolution with persisted accept/rollback metadata instead of one-way mutation

Closed-position performance summaries now expose a slightly more honest decomposition of outcomes: inventory contribution, fee contribution, and operational touch counts are stored alongside headline PnL so the operator can distinguish cleaner wins from high-touch wins.

### LP overview reporting

Zenith now includes a cached LP Agent overview helper for operator-facing visibility. This data is used in briefings and `/performance` output as an external reference layer, not as a hidden execution-policy input.

- Cached view of total PnL, total fees, open/closed positions, win rate, average hold time, and ROI
- Falls back to local lesson/performance summaries if LP Agent data is unavailable
- Stays read-only and bounded so it improves visibility without creating a second control plane

### Candidate quality gates

Holder-quality checks now rely on stronger signals such as `common_funder` and `funded_same_window`. The older `similar_amount` heuristic was removed because it over-flagged legitimate small holders at top-100 scale.

### Deploy basis and action contracts

Zenith now hardens deploy-time evaluation inputs and action contracts a little more aggressively:

- `deploy_position` treats `initial_value_usd` as required basis data for evaluation, but still backfills a bounded estimate from the SOL leg for legacy callers
- operator/agent prompts no longer require redundant `get_active_bin` choreography before `deploy_position`, because the tool already fetches the active bin internally
- runtime close / rebalance / fee actions now expose explicit subreason codes, making action attribution easier to inspect and test

---

## Compounding caveat

Compounding is currently **safe-mode claim/planning**, not true in-place compounding.

- `auto_compound_fees` can claim fees and produce a deterministic reinvestment plan
- The planner still uses `choose_distribution_strategy` and `calculate_dynamic_bin_tiers`
- The current runtime intentionally blocks duplicate same-pool deployment and does not claim that an in-place compound happened when it did not

Treat the compounding output as a claim plus a suggested next action, not as a completed in-position reinvest.

---

## Verification surfaces

Zenith now has focused provider-free checks for important deterministic control paths:
- `npm run test:hardening` — committed runtime-hardening gate covering journal/recovery tests, screening/management/startup fail-closed tests, executor boundary checks, operator drills, chaos drills, and the provider-free dry-run startup check
- `state.test.js` — bounded state/evaluation summaries
- `tools/screening.test.js` — deterministic ranking and hard gates
- `memory.test.js` — broader strategy-memory buckets
- `prompt.test.js` — prompt/runtime contract expectations
- `lessons.test.js` — threshold-evolution key alignment and attribution summaries
- `runtime-policy.test.js` — runtime management policy decisions
- `test/test-runtime-fixes.js` — pure helper checks for required SOL floors and canonical screening-threshold summaries
- `test/test-executor-boundary.js` — direct executor boundary checks for duplicate exposure, balance reserve enforcement, closed-position rejection, and blocked write recording
- `cycle-trace.test.js` — cycle/action correlation and replay-envelope writing
- `cycle-replay.test.js` — provider-free replay of deterministic screening and management decisions
- `degraded-mode.test.js` — fail-closed degraded-mode contracts
- `reconciliation.test.js` — deterministic replay-vs-recorded comparison helpers
- `startup-snapshot.test.js` — provider-free startup snapshot cache/fail-closed validation checks
- `management-runtime.test.js` — provider-free management runtime runner checks
- `evidence-bundles.test.js` — persisted bad-cycle evidence bundle checks
- `test/test-dry-run-startup.js` — provider-free dry-run startup verification for boot recovery + startup snapshot readiness
- `test/test-operator-drill.js` — provider-free screening reconciliation and fail-closed evidence drill
- `test/test-chaos-drill.js` — provider-free chaos drill for startup/provider failure, stale-PnL management, and bounded LP Agent fallback
- `portfolio-guards.test.js` — portfolio pause triggers and clearing behavior
- `runtime-health.test.js` — machine-readable heartbeat persistence
- `replay-review.test.js` — replay lookup and reconciliation review helpers
- `operator-controls.test.js` — GENERAL write arming and operator audit logging
- `agent-tools.test.js` — read-only GENERAL tool surface by default
- `regime-packs.test.js` — deterministic regime classification and pack application
- `negative-regime-memory.test.js` — cross-pool negative regime cooldown persistence
- `counterfactual-review.test.js` — observational counterfactual review persistence

Manual external smoke still exists for screening and the full agent path (`npm run test:screen`, `npm run test:agent`), but `npm run test:hardening` is the stronger reproducible signal for the deterministic control plane. The screening smoke now injects an empty-position view so it remains wallet-free while still exercising live discovery/detail reads.

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
