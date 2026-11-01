# Privacy / DSAR — #1765 (parent #1717, F-41)

Status: implemented as a port-first slice. The pure port is
`src/privacy/privacyDsar.ts`; the pure handlers are
`src/privacy/privacyRoutes.ts`; the switch is
`src/config/privacyModes.ts` (`PRIVACY_DSAR_MODE`); the server
wiring is the `/api/privacy/*` block in `src/server.ts`.

## Routes (all session-gated, caller-own-subject only)

| Route | Purpose |
| --- | --- |
| `GET /api/privacy/status` | ADMT pre-use notice (PRV-003), Sec-GPC state (PRV-004), effective preferences. |
| `GET` / `POST /api/privacy/preferences` | ADMT opt-out + sale/sharing opt-out (PRV-003/PRV-004). POST accepts boolean fields only; `Sec-GPC: 1` forces both opt-outs on. |
| `GET /api/privacy/export` | Consolidated export payload (PRV-002) with per-source `coverage`. |
| `POST /api/privacy/erasure` | Erasure cascade (PRV-001) with a per-leg report; clears the caller's session cookie on a handled response. |

Auth: 401 without a session, 403 for a legacy session (no
`internalUserId`) or a subject mismatch. The subject is derived
from the session, never from request input.

## Erasure cascade

Legs run in registration order; a leg failure is isolated and
fails the report closed without aborting later legs. The report
is complete only when every leg erased with zero residuals.
A `deferred` leg is reported, never silently omitted.

Production wiring today: the session leg deletes the subject's
privacy record (`privacy:prefs:<subject>` in the SessionStore)
and clears the session cookie. The Orchestrator, Research, and
Screener DO legs and the Vectorize leg are deferred: no
per-subject delete RPC exists on those DO classes on current
main, and Vectorize vectors are keyed by report/plan/outcome
id, never by subject. Follow-up (not this slice): one
`eraseSubjectData` callable per DO, then flip each leg from
deferred to live. Until then a production erasure report
reads `complete=false` — that is the honest answer, not a
failure to report.

Other sessions of the same subject are not enumerated:
`KvLike` has no list operation, so erasure terminates the
caller's own session only. Cross-session revocation on
erasure is a follow-up requiring a subject→sessions index.

## ADMT

An opted-out subject (stored preference, live GPC signal, or
strict mode without explicit opt-in) is served by the
deterministic static rule path. The opt-out changes the
decision path only: IAAA gates, payment HITL gates, and audit
writes still apply inside the static path. The mode switch
is execution-owner-set only; request-supplied mode values are
ignored, so a subject cannot flip their own execution to a
weaker mode.

## GPC

Only the exact value `1` (ignoring surrounding whitespace)
opts out. Enforcement is monotone: GPC forces both opt-outs
on and never clears an existing opt-out. No sale/sharing path
exists to switch off on current main (subprocessors per the
privacy assessment are Cloudflare, GitHub, E*TRADE, Slack);
GPC is therefore recorded on the privacy record and enforced
at the ADMT/preference surfaces, and reported by the status
endpoint.

## Retention (shared with #1766)

The registry in `src/privacy/privacyDsar.ts` covers
`mas_messages`, `screener_runs`, and `research_runs` at a
30-day bound, matching the existing nightly `mas_messages`
pass (issue #255) and the #635 task-ledger tiers. This is the
SHARED registry: #1766 extends this table list and adds
snapshot export, orphan sweep, and purge-run audit around it.
#1765 does not build a second retention pass, and #1766 must
not duplicate this registry.

## Switch

`PRIVACY_DSAR_MODE`: `standard` | `strict`, case-insensitive,
blank/unset → `standard`, unrecognized → `standard`
fail-closed with a `privacy.config_error` audit. Resolution:
run > session > user > global env > built-in. No production
value is set by this slice; unset = `standard`. In strict
mode, ADMT routes to the static path unless the subject
explicitly opted in, and the export payload includes the full
preference + notice record. No endpoint is removed in either
mode.

## Tests

`tests/privacy_dsar_1765.test.ts` (18 tests, TDD red-first):
GPC parsing + monotone enforcement, scoped mode resolution +
fail-closed, cascade zero-residual proof, per-leg failure
isolation, deferred-leg reporting, export assembly, ADMT
notice + routing, retention registry, and all four routes
(401/403/method gates, own-subject-only, no false pass).
