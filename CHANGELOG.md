# Changelog

This file documents the major additions and behavior changes present in this fork of Meridian, now rebranded as Zenith.

## Recent updates

### 2026-03-26

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
