# Changelog

This file documents the major additions and behavior changes present in this fork of Meridian, now rebranded as Zenith.

## Recent updates

- Added deterministic LP planning flows with `choose_distribution_strategy` and `calculate_dynamic_bin_tiers`, plus runtime reuse of preloaded planner context during screening and rebalance decisions.
- Added LP-agent wallet scoring with `score_top_lpers`, wallet-score memory per pool, and conservative score preloading for top candidates to stay rate-aware.
- Added distribution success-rate memory from closed positions so future cycles can reuse prior outcomes by distribution key.
- Updated runtime orchestration so the manager runs on a 3 minute cadence, prefers `rebalance_on_exit` immediately for out-of-range positions unless a higher-priority exit already fired, and de-duplicates same-cycle actions.
- Updated fee handling so `auto_compound_fees` stays in safe-mode claim-and-plan mode with no true in-place reinvest, while still using deterministic planning helpers.
- Refreshed docs and branding, including the README rename from Meridian to Zenith and aligned operator-facing runtime notes.
