# Runtime Hardening Review

Date: `2026-03-27`
Status: committed repo review note

## Bottom line

The runtime-hardening layer stays acceptably lean. Zenith now has a bounded recovery/control-plane shell around the existing runtime rather than a new event system: append-only workflow journaling, boot-time recovery suppression, deterministic replay/reconciliation, explicit fail-closed startup behavior, and operator-facing recovery visibility.

## What this phase materially added

- Durable workflow lifecycle tracking through `action-journal.js` and executor-boundary write journaling
- Observation-first boot recovery in `boot-recovery.js` with write suppression on ambiguity or journal corruption
- Recovery-aware state sync guards in `state.js`
- Provider-failure classification and stale-input rejection in `degraded-mode.js` and `startup-snapshot.js`
- Screening and management hardening for stale/error-shaped inputs in `tools/screening.js`, `runtime-policy.js`, and `management-runtime.js`
- Provider-free operator and chaos drills in `test/test-operator-drill.js`, `test/test-chaos-drill.js`, and `test/test-dry-run-startup.js`

## Anti-bloat check

- Recovery is journal-driven and observation-first, not auto-remediation by speculative writes.
- Replay and reconciliation helpers remain separate proof surfaces, not a second strategy engine.
- LP Agent failures remain bounded/fallback-only; they do not become hidden execution inputs.
- Verification is now exposed as a single command instead of a scattered set of ad hoc runs.

## Remaining sharp edges to keep in mind

- Provider-free drills prove the control-plane layer well, but they are not a substitute for occasional live dry-run smoke against real upstream APIs.
- `test:hardening` is the deterministic repo gate; external-network smoke remains intentionally separate so hardening checks stay reproducible.
- Boot recovery still parks ambiguous outcomes as `manual_review` instead of attempting writes on behalf of the operator.

## Verification command

Run the committed hardening gate:

```bash
npm run test:hardening
```

Optional follow-up smokes:

```bash
npm run test:screen
npm run test:agent
```

## Latest local verification pass

- `npm run test:hardening` — passed on `2026-03-27`
  - `test:hardening:core`: 92 tests passed, 0 failed
  - `test:hardening:drills`: `test/test-executor-boundary.js`, `test/test-operator-drill.js`, and `test/test-chaos-drill.js` passed
  - `test:hardening:startup`: `test/test-dry-run-startup.js` passed
- `npm run test:screen` — passed on `2026-03-27`
- JS diagnostics over the workspace reported 0 errors during the closure pass; remaining Biome infos/warnings were pre-existing style/lint notes.
