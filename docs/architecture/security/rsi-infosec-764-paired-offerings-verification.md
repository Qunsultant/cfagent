# #764 paired offerings verification

Parent program: Qunsultant/cfagent#764. Slice issue: Qunsultant/cfagent#2929.
Verified 2026-11-02 against current main. Each offering below cites a
route, a UI surface, and a test file — nothing in this record rests on
assertion, and nothing here closes anything (close-out pass later, per
the 2026-11-02 sequencing override).

## #654 — calibration dashboard (user-visible trust metrics)

- Route: `GET /research/track-record/calibration` in
  `src/agents/routes/screenerResearch.ts` — resolves the ResearchAgent
  for the caller, 503 without a binding, and returns
  `buildCalibrationFromTrackRecord` over the #340 track record's
  recorded evaluations. Measurement only: it never recomputes outcomes
  and never touches thresholds or weights (those stay behind #17's
  reviewed-config rule).
- UI: `src/client/CalibrationDashboard.tsx`, rendered in the Track
  Record tab by `src/client/ScreenersHub.tsx` — overall, per-thesis,
  per-strategy, per-regime, and per-month direction accuracy; only a
  scored direction counts as evaluated (unscored ideas are pending,
  never misses); low-sample theses (<20 evaluated) are flagged, not
  hidden.
- Tests: `tests/calibration-dashboard-route.test.ts`,
  `tests/calibration-dashboard.test.ts`, `tests/calibration-report.test.ts`.
- Honest boundary, stated in the UI itself: portfolio-context
  adjustments are NOT shown — they need #17's opt-in position context,
  which is not built. That is a #17 capability gap, not a #654 defect,
  and this slice does not invent it.

## #651 — autopilot status and controls (kill-switch home)

- Route: `GET /autopilot`, `POST /autopilot/state`, and
  `POST /autopilot/kill-switch` in `src/agents/routes/autopilot.ts` —
  the kill-switch write records the state plus a reason.
- UI: `src/client/components/AutopilotControlCenter.tsx` — live policy
  limits from the single source of truth
  (`src/services/riskPolicyEngine.ts`), the policy-decisions audit
  table from `GET /autopilot` verdicts (`mas_policy_verdicts`), and the
  emergency platform kill-switch modal posting to
  `/api/autopilot/kill-switch`. The tab states it is not the source of
  truth for run state, limits, or the kill switch — the server state is.
- Tests: `tests/autopilot_control_center.test.ts`, including the
  kill-switch-blocks-autonomous-actions case and the #651
  policy-decisions mapping cases (blocked / executable / held verdicts).

## #270 — /api/audit read surface (shipped)

- Routes: `GET /api/audit`, `GET /api/audit/:id`, and
  `GET /api/audit/history` in `src/agents/routes/audit.ts` and
  `src/server.ts`, over `mas_events` with inserts owned by the single
  `recordAudit()` funnel. `POST /api/audit/event` is the same funnel —
  it is what the #700 scanner persistAudit reroute writes through, so
  the scanner's audit events land in exactly the store this read
  surface serves.
- Tests: `tests/audit-event-endpoint.test.ts` — 201 round-trip
  (posted event readable via `GET /api/audit`), 400s that write
  nothing, and a pin that the advertised contract matches the server
  route (the original #270 failure class: UI advertising endpoints
  that did not exist).

## #180 — per-user MCP keys (shipped)

- Routes: `/mcp` and `/api/mcp` in `src/server.ts` require an app
  session or a per-user API key (`src/security/apiKeys.ts`
  `mintApiKey`/`verifyApiKey`); the caller-asserted `x-user-id` header
  no longer asserts anything. Key lifecycle: `POST /api/api-keys`
  (mint) and `DELETE /api/api-keys/:id` (revoke), both session-gated.
- UI: `src/client/ApiKeysPanel.tsx` (plus the key in the IAAA endpoint
  catalog, `src/client/iaaaEndpointCatalog.ts`).
- Tests: `tests/mcp_api_key_transport.test.ts`.

## What this slice did NOT do

- No endpoint added, removed, or renamed; no code path deleted; no
  behaviour change anywhere.
- No issue closed (#654, #651, #270, #180 are already closed; #764
  stays open).
- No production switch value set; no secret created.
