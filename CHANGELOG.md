# Changelog

This file documents the major additions and behavior changes present in this fork of Meridian, now rebranded as Zenith.

## Recent updates

### 2026-03-28

- Continued the architecture cleanup by shrinking `tools/dlmm.js` through dedicated `tools/dlmm-planner.js`, `tools/dlmm-settlement.js`, `tools/dlmm-rebalance-helpers.js`, and `tools/dlmm-position-context.js` seams while keeping the public DLMM tool surface stable.
- Continued the executor cleanup by extracting `tools/executor-safety.js`, leaving `tools/executor.js` with a thinner coordinator role over dispatch, lifecycle, and side effects.
- Added direct tests for `screening-cycle-runner.js`, `management-cycle-runner.js`, the `/preflight` shell helper, and headless Telegram operator ingress so the orchestration layer no longer depends only on indirect hardening coverage.
- Hardened `operator-controls.js` and `evidence-bundles.js` to use backup-aware reads and stronger write persistence, bringing them closer to the durability standard used by `state.js`, `runtime-health.js`, and the safer rollout path.
- Fixed the headless/non-TTY operator contract so Telegram now remains available for `/health`, `/recovery`, and operator commands even when the runtime boots without a REPL or with autonomous writes blocked.
- Fixed live `base_mint` enrichment so pool mint lookup failures now fail closed instead of degrading same-token exposure blocking for untracked live positions.
- Aligned manual `/evolve` with the same safe live threshold-rollout engine used by automatic evolution instead of treating it as a separate manual mutation path.
- Hardened safe live threshold evolution so it stays limited to `minFeeActiveTvlRatio` and `minOrganic`, uses realized-close data only, keeps one active rollout at a time, preserves bounded step sizes and automatic rollback, fails closed on unreadable lessons / rollout / config state, writes evidence for every mutation decision, and recovers `apply_pending` / `rollback_pending` rollout phases on startup.
- Updated README and changelog documentation to match the current operator/runtime contract after the cleanup program and safe live evolve work.

### 2026-03-27

- Centralized live governance into shared runtime-policy helpers so tracked-position exits, screening skip checks, deploy admission, and exposure guards now reuse one canonical decision surface.
- Threaded persistent `cycle_id` / `action_id` / `workflow_id` lineage through executor dispatch, tracked-position state, realized performance records, replay envelopes, and counterfactual outcome attachment.
- Persisted success-path replay envelopes for screening and management cycles so deterministic replay/reconciliation no longer depends only on fail-closed or failed runs.
- Normalized operator arming and recovery-resume reads behind one persisted operator-control snapshot, then reused that snapshot across command handlers, runtime health, REPL, and Telegram flows.
- Narrowed execution/orchestration boundaries by extracting executor decision-context and lifecycle helpers while keeping DLMM close-performance packaging adapter-owned.
- Updated README and changelog documentation to reflect the four-phase governance, lineage, operator, and boundary-hardening pass.
- Added a bounded adaptation layer with `regime-packs.js`, `negative-regime-memory.js`, and `counterfactual-review.js`, plus rollout-based threshold evolution in `lessons.js`.
- Screening now applies fixed regime-conditioned parameter packs deterministically and uses adaptive deploy sizing under hard reserve/floor/cap rules.
- Threshold evolution now records rollout metadata and can auto-rollback degraded screening changes instead of ratcheting them permanently.
- Added dwell/decay hysteresis to regime switching so pack selection does not bounce too quickly on marginal cycle inputs.
- Added cross-pool negative regime cooldown memory with stronger sample-quality gating, so repeated bad regime/strategy combinations must accumulate enough evidence before they block screening.
- Added observational counterfactual review records for alternate regime packs, plus realized-outcome usefulness hints once the active choice later closes.
- Added a lean elite-ops layer with `portfolio-guards.js`, `runtime-health.js`, `replay-review.js`, and `operator-controls.js` to extend Zenith beyond basic runtime hardening without adding a dashboard or second control plane.
- Added portfolio-level autonomous trading pauses based on recent realized loss, stop-loss streaks, broader equity drawdown, and open-position unrealized loss, with deploy/rebalance enforcement at executor and DLMM boundaries.
- Added runbook-grade operator commands for `/health`, `/journal`, `/failure <id>`, `/replay <cycle_id>`, `/reconcile <cycle_id>`, `/review`, `/resume <why>`, `/arm`, and `/disarm`.
- Hardened the GENERAL agent tool surface so free-form chat is read-only by default unless explicitly armed for a bounded window.
- Removed the hardcoded Jupiter API key and switched setup/runtime so wallet secrets are env-only instead of being read from `user-config.json`.
- Added a machine-readable runtime heartbeat in `data/runtime-health.json` with startup, cycle, recovery, provider-health, and write-arm status.
- Made operator arming and recovery-resume overrides durable across restart windows instead of keeping them process-local only.
- Split the remaining inline management/screening cycle bodies out of `index.js` into `management-cycle-runner.js` and `screening-cycle-runner.js` so boot/wiring is cleaner and easier to reason about.
- Split the remaining boot, REPL, and Telegram operator surfaces out of `index.js` into `interactive-interface.js` and `startup-interface.js`, leaving the top-level file closer to pure orchestration.
- Added new provider-free coverage in `portfolio-guards.test.js`, `runtime-health.test.js`, `replay-review.test.js`, `operator-controls.test.js`, and `agent-tools.test.js`, and rolled them into `npm run test:hardening`.
- Added a committed runtime-hardening closure plan in `runtime-hardening-plan.md`, mapping the action journal, restart recovery, fault-injection seams, and reconciliation surfaces onto the current Zenith files.
- Added a committed runtime-hardening review note in `runtime-hardening-review.md`, capturing the anti-bloat boundary, recovery posture, and remaining sharp edges for this phase.
- Added `test/test-dry-run-startup.js` as a provider-free dry-run startup verification script covering clean boot recovery and startup snapshot readiness.
- Added `test:hardening:*` npm scripts plus `npm run test:hardening` as the deterministic runtime-hardening verification gate.
- Kept `test/test-screening.js` wallet-free by injecting an explicit empty-position view into deterministic candidate ranking smoke.
- Updated the README to document the action journal, boot recovery, `/recovery`, the committed hardening plan/review artifacts, and the new verification command.

### 2026-03-26

- Added startup snapshot extraction with fail-closed validation and bounded caching (`startup-snapshot.js`, `startup-snapshot.test.js`).
- Added a separately testable deterministic management runtime runner (`management-runtime.js`, `management-runtime.test.js`).
- Added persisted bad-cycle evidence bundles and REPL inspection via `/failures` (`evidence-bundles.js`, `evidence-bundles.test.js`).
- Added bounded strategy-proof reporting via `/proof`, including realized inventory-vs-fee contribution, operational touch counts, strategy breakdowns, and dominant close reasons.
- Added Phase 0 serious-capital proof infrastructure: executor-boundary checks, cycle/action correlation IDs, replay envelopes, fail-closed degraded-mode helpers, and minimal deterministic reconciliation helpers.
- Added direct executor-boundary regression coverage in `test/test-executor-boundary.js`.
- Added provider-free replay and fail-closed contract coverage in `cycle-trace.test.js`, `cycle-replay.test.js`, `degraded-mode.test.js`, and `reconciliation.test.js`.
- Threaded explicit `cycle_id` / `action_id` correlation through runtime evaluation and tool outcomes for clearer auditability.
- Added fail-closed startup/screening handling for unavailable or invalid wallet/positions/candidate payloads.
- Removed redundant deploy choreography by stopping the requirement to pre-call `get_active_bin` before `deploy_position` when no standalone bin inspection is needed.
- Hardened deploy-time basis data so `initial_value_usd` is treated as required evaluation input, with a bounded SOL-leg fallback for legacy callers.
- Replaced the blunt fixed post-close wait with a bounded settlement check/polling path to reduce stale-balance races more safely.
- Masked wallet private key entry in the interactive setup flow instead of echoing secrets in plain text.
- Added explicit runtime management subreason codes so deterministic actions are easier to inspect and test.
- Added explicit out-of-range direction tracking (`above` / `below`) to position state and operator-facing reporting.
- Added a short-lived discovery/startup cache to reduce bursty hot-path fetches for screening and operator commands.
- Added an exact pre-LLM skip for the no-candidate hole: when deterministic screening yields no shortlist, the cycle is recorded as `skipped_no_candidates` without invoking the model.
- Added a short post-close settlement wait before downstream accounting continues, reducing stale-balance races after close transactions.
- Added focused regression coverage for subreason codes, out-of-range direction tracking, and discovery-cache reuse (`runtime-policy.test.js`, `state.test.js`, `tools/screening.test.js`).

### 2026-03-25

- Added a low-bloat cached LP-overview helper for operator-facing reporting, with bounded integration into briefings and `/performance` output only.
- Added `runtime-helpers.js` to centralize pure deterministic utility logic such as effective SOL floor calculation and canonical screening-threshold summaries.
- Added provider-free helper regression coverage in `test/test-runtime-fixes.js`.
- Hardened staged screening so the bot cheap-ranks a wider candidate set, surfaces a deterministic shortlist, and deeply enriches only the strongest finalists.
- Shifted more management behavior into deterministic runtime policy so obvious close / rebalance / fee-threshold actions are resolved before the LLM is asked to reason.
- Added richer operator-facing reporting with `/candidate <n>`, `/evaluation`, and `/performance` surfaces for finalist inspection, cycle telemetry, and closed-position attribution.
- Improved post-trade attribution by storing inventory contribution, fee contribution, and operational touch counts in lessons/performance history.
- Fixed adaptive threshold drift so threshold evolution now updates live screening keys actually used by the runtime.
- Improved inventory-aware safety by carrying `base_mint` through tracked/open positions, strengthening duplicate-token awareness.
- Added provider-free focused tests for runtime policy and threshold evolution (`runtime-policy.test.js`, `lessons.test.js`).
- Updated the screening smoke harness so it reflects the current ranked-candidate flow and exits cleanly.

- Added deterministic LP planning flows with `choose_distribution_strategy` and `calculate_dynamic_bin_tiers`, plus runtime reuse of preloaded planner context during screening and rebalance decisions.
- Added LP-agent wallet scoring with `score_top_lpers`, wallet-score memory per pool, and conservative score preloading for top candidates to stay rate-aware.
- Added distribution success-rate memory from closed positions so future cycles can reuse prior outcomes by distribution key.
- Updated runtime orchestration so the manager runs on a 3 minute cadence, prefers `rebalance_on_exit` immediately for out-of-range positions unless a higher-priority exit already fired, and de-duplicates same-cycle actions.
- Updated fee handling so `auto_compound_fees` stays in safe-mode claim-and-plan mode with no true in-place reinvest, while still using deterministic planning helpers.
- Refreshed docs and branding, including the README rename from Meridian to Zenith and aligned operator-facing runtime notes.
- Added deterministic candidate scoring and code-owned screening gates, so pool selection is ranked before LLM reasoning rather than relying on filtered API order alone.
- Added bounded evaluation/observability state for screening and management cycles, plus tool-outcome tracking for blocked, successful, and failed write actions.
- Simplified prompt and memory surfaces: screening candidate blocks now keep hard gates, ranking score, planner output, and LP-wallet summaries while trimming narrative/memory noise.
- Simplified strategy memory by moving from exact `strategy + bin step` recall toward broader reusable buckets, while preserving fallback support for older stored keys.
- Moved management interval ownership into deterministic runtime logic based on the most volatile open position instead of leaving cadence tuning to prompt-driven `update_config` behavior.
- Removed the noisy `similar_amount` bundler heuristic from token-holder analysis to reduce false positives in top-100 holder screening.
