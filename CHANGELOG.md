# Changelog

This file documents the major additions and behavior changes present in this fork of Meridian, now rebranded as Zenith.

## Recent updates

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
