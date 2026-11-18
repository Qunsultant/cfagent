# Gate-coverage inventory — IAAA ungated / public surfaces (#1754)

Audit of every HTTP surface reachable through the Worker entrypoint,
verified against current main (base `8c29b0cc`, 2026-10-27), for the
#1717 program slice #1754 (scan rows F-06, F-20, F-44).

## Method

Every branch of `handleFetch` in `src/server.ts` was enumerated
(branch condition → gate call → downstream handler), and each
"no gate in the branch" case was traced into the handler it calls
(A2A dispatcher, MCP transports, scanner DO, payment routes, Slack
verifier, NLQ webhook handler, approval-link verifier). A surface is
listed only when its gate was read in code, not inferred from a doc.
The endpoint catalog (`src/client/iaaaEndpointCatalog.ts`) was used
as a cross-check, not as evidence: three of its `public` entries
turned out to be unintended and are closed by this slice (§5).

Status vocabulary:

- **PDP-gated** — session + `checkRoutePermission` (PDP) enforcement.
- **Session-gated** — `requireAuth`, any signed-in user; no PDP check.
- **Session + admin** — session + live platform-admin membership.
- **Grant-gated** — session + wired session + `canGrantRole`.
- **Signature-gated** — HMAC/webhook signature verification, fail-closed.
- **Token-gated** — capability bearer/signed token, fail-closed.
- **Payment-gated** — x402 paid tool (payment verified by facilitator).
- **Public by design** — reachable without identity, deliberately,
  with the stated reason. "Public" here never means "unexamined".
- **Gap closed** — was ungated without a recorded decision; gated by
  this slice (or, where noted, recorded as deliberately ungated with
  its reason, which is itself the close).

No surface is left in "unknown" status. Counts: §1–§4 + §6 name
every branch; §5 names the three closures.

## 1. PDP-gated (session + PDP, `integration:connect`)

| Surface | Gate | Evidence |
| --- | --- | --- |
| `GET /auth/etrade/start`, `POST /api/etrade/oauth/start` | Session + PDP `integration:connect` (wired sessions; legacy inside the §8 bound take the pre-change path; grace-expired legacy denied `legacy_pdp_grace_expired`) | `src/server.ts` etrade-start branch; `shouldEnforcePdp` / `checkRoutePermission` |
| `POST /api/etrade/oauth/verifier` | Same PDP gate as etrade start | `src/server.ts` verifier branch |
| `GET /auth/public/start` | Same PDP gate as etrade start | `src/server.ts` public-start branch |
| `POST /api/public/connect` | Same PDP gate as etrade start | `src/server.ts` public-connect branch |

The PDP is not a universal gate: it enforces exactly these four
routes (plus the grant checks in §3). Every other session route
below never consults memberships — that is the documented shape
(authz.md §9 residual gaps), not a bypass found by this audit.

## 2. Session-gated (any signed-in user, no PDP check)

One gate call each, `requireAuth` → 401 without a session, with the
caller's own login (never a caller-asserted header) selecting the
downstream instance:

- **E*TRADE lifecycle:** `/auth/etrade/callback` (session + state
  check, redirect on unauthenticated), `/api/etrade/oauth/status`,
  `/api/etrade/oauth/diagnostics`, `/api/etrade/oauth/renew`.
- **Public lifecycle:** `/auth/public/callback` (session + state
  check; pending flow must belong to this session's login),
  `/api/public/status`, `/api/public/disconnect`.
- **Schedule dashboard:** `/api/schedule/*` — the gate sits before
  the ScheduledAgent stub, so an unauthenticated call never reaches
  the DO. Mutations (`POST /api/schedule/goals`, goal POST/DELETE)
  are session-gated, not PDP-gated (F-06, §6).
- **Social:** `/api/social/brief`, `/api/social/approval(s)`,
  `/api/social/posts`, `/api/social/token-health`.
- **Identity / self:** `/api/me`, `/api/iaaa/overview` (session +
  platform-admin/wired rules inside — see §3), `/api/iaaa/*`
  access-request family (see §3).
- **Governance / jobs / retention / audit / reports / retrieval:**
  `/api/governance/seed-halt`, `/api/chains/status`,
  `/api/chains/reconcile`, `/api/jobs/history`,
  `/api/jobs/reconcile`, `/api/audit/history`,
  `/api/reports/list`, `/api/reports/seed-canonical`,
  `/api/retrieval/populate-market-graph` — each session-gated, with
  the admin pattern (§3) on the mutating ones.
- **API keys:** `GET /api/api-keys` (list own keys),
  `POST /api/api-keys` (mint; step-up gate
  `requiresStepUpForMint`, NOT PDP — no Slice 3 permission maps to
  credential minting).
- **MCP transport:** `/mcp`, `/api/mcp` — session OR per-user API
  key (`cfk_…`, `verifyApiKey`); no credential → 401 before any DO
  access; the caller-asserted `x-user-id` header asserts nothing.
- **Agentic wallet:** `/api/payments/agentic/*` — session required;
  the pre-#183 shared-fallback identities are removed.
- **Premium:** `/api/premium/*` — session when present (traffic
  runs under the session login); without one, identity headers are
  stripped and traffic runs under the dedicated
  `PREMIUM_GATEWAY_INSTANCE` (nobody's user instance), with payment
  rows bound to the verified payer.
- **Omnichannel (session-required test/simulator routes):**
  `/api/trading/email/inbound`, `/api/trading/slack/test`,
  `/api/trading/slack/link`, `/api/trading/voice/turn`,
  `/api/trading/voice/test`, `/api/trading/voice/greeting`,
  `/api/trading/options/*`, `/trading/options/*`,
  `/api/schedules`, `/voice/trade` + `/api/trading/voice/ws`
  (WebSocket upgrade + session).
- **Browser:** `/api/browser/snapshot`, `/browser/snapshot`,
  `/api/browser/transaction-snap`, `/browser/transaction-snap`,
  `/api/browser/snap/transaction` — session required (#181).
- **Slack-adjacent app routes:** `/api/trading/slack/*` above;
  the Slack webhooks themselves are signature-gated (§4).
- **Misc app routes:** `/api/features` is session-OPTIONAL
  (anonymous callers get unpersonalized flags; the response is a
  boolean flag map — no user data, no secrets — so the optional
  session is not a gap), `/api/qa/investigate` (see §5),
  `/api/memory/search` (see §5), `/api/options/flows/*` (see §5),
  `/openapi.json`, `/api/docs` (session-gated provisional spike;
  the #1024 docs-exposure decision is still open),
  `/clear`, `/reset`, `/api/clear`, `/api/reset` (session).
- **Generic forwarder:** `/api/*` (anything not matched above) —
  session-gated, then forwarded to the caller's own SearchAgent
  instance with `x-user-login` set from the session. Not PDP-gated
  (F-06, §6).
- **Agents SDK routing:** `routeAgentRequest` paths — both
  `onBeforeConnect` (WebSocket, plus origin check) and
  `onBeforeRequest` (HTTP) require a session (401 otherwise).
- **Feature-flag layer (not a gate):** routes matched by
  `matchFeatureForRoute` return 404 `FEATURE_DISABLED` when their
  feature is off. This is fail-closed availability, not
  authorization, and is never counted as a gate above.

## 3. Session + admin / grant gates

| Surface | Gate |
| --- | --- |
| `GET /api/iaaa/overview` | Session + wired session + PDP platform-scope check via the seam (`checkPlatformPermission`, GAP-1; decision identical to the former live platform-admin membership test) (401 no session; 403 legacy; 403 wired non-admin with no data) |
| `GET /api/iaaa/access-requests` | Session + wired session + `canGrantRole` tenant-admin check (403 otherwise) |
| `POST /api/iaaa/access-request/decision` | Session + wired session + `canGrantRole` for the requested role (403 otherwise); grant is atomic via `grantMembership` |
| `POST /api/iaaa/access-request` | Session + wired session + active membership in the tenant (403 otherwise) |
| `POST /api/telemetry/decisions/:id/decide\|apply\|supersede\|expire`, `POST /api/telemetry/reconcile` | Session + PDP platform-scope check via the seam (`buildAdminOverview`, GAP-1); reads (`GET /api/telemetry/summary`, `/api/telemetry/decisions`) are session-gated, tenant-scoped |
| `/api/retention/purge`, `/api/governance/seed-halt`, `/api/chains/reconcile`, `/api/jobs/reconcile`, `/api/reports/seed-canonical` | Session + the IAAA admin pattern (requireAuth → wired session → PDP platform-scope check via the seam, GAP-1, fail-closed, no data on 403) |

## 4. Non-session gates (signature, token, payment)

| Surface | Gate | Evidence |
| --- | --- | --- |
| `POST /nlq/webhook`, `/api/trading/nlq/webhook`, `/api/nlq/webhook` | HMAC webhook signature + 5-minute timestamp window + replay nonce (401 invalid, 409 duplicate); action requests are never emailed | `handleNlqWebhookRequest` in `src/server.ts` |
| `POST /slack/commands`, `/slack/slash`, `/slack`, `/slack/events`, `/slack/interactions` | Slack signing-secret verification, mandatory — unconfigured is a loud 503, never a silent pass-through | `gateSlackRequest` in `src/server.ts` |
| `POST /api/payments/webhook`, `/payments/webhook` | Provider webhook signature verified downstream (Stripe/PayPal/Lemon Squeezy HMAC; 401 invalid; unsupported provider rejected before verification) | `src/agents/routes/payments.ts` webhook branch |
| `GET /api/trading/email/approve` | Signed approval-link token: HMAC + expiry + login binding, verified at the edge (fast shape check, fail-closed page) and again in the Orchestrator DO (signature + expiry + principal-map re-check) before the shared engine executes | `verifyApprovalLinkForPrincipal`, `src/trading/channels/signedLinks.ts` |
| `POST /a2a/<agent>` (dispatch) | Dedicated `A2A_API_TOKEN` Bearer token, timing-safe compare — unset token disables dispatch entirely (503), missing/wrong token is 401; the gate sits ahead of agent resolution | `src/a2a/index.ts` `handleA2A` |
| `/mcp/scanner` tool `screen_options` | x402 payment: `$0.05` USDC per call, verified via the x402 facilitator before the handler runs (`paidTool`) | `src/services/cloudflareWalletsScanner.ts` |
| `/mcp/scanner` free tools | `scanner_status` (availability/pricing/config — public info, no user data), `get_scan_job` (single job by UUID — the UUID is the capability), `list_scan_jobs` (jobs on the caller's affinity instance) — see the residual in §7 | Same file; free `tool()` registrations |

## 5. Gaps closed by this slice (were ungated, no recorded decision)

| Surface | Was | Now | Why this close |
| --- | --- | --- | --- |
| `POST /api/qa/investigate` | No auth at all; any caller could spend LLM inference with arbitrary input. The endpoint catalog listed it `public` with intent unasserted. | Session OR dedicated `QA_INVESTIGATE_TOKEN` Bearer token (timing-safe, fail-closed when unset), checked before body parsing — unauthenticated callers trigger no LLM work. `scripts/qa-smoke.mjs` presents the token; `.github/workflows/deploy.yml` passes it from the `QA_INVESTIGATE_TOKEN` secret. | The only non-session caller is the post-deploy smoke script, which cannot hold a user session. The token is deliberately NOT the A2A token: QA diagnostics and agent dispatch are different trust domains. The token is platform-set (owner action) and never user/session/run-configurable, so no caller can disable their own gate. Until the owner sets the secret, smoke investigation comments warn 401 and are skipped; the smoke itself still passes. |
| `POST /api/memory/search` | No auth at all; only a 60/minute throttle stood between an anonymous caller and stored vector-memory outcomes. Catalog: `public`. | Session-gated (`requireAuth`, 401 unauthenticated) before the throttle. | The only in-app caller (`src/client/memoryApi.ts`) runs same-origin and already sends the session cookie, so no legitimate call path changes. |
| `GET|ANY /api/options/flows/*` (live, historical, news, insider, congress, summary, presets) | No auth at all. Catalog: `public`, intent unasserted. | Session-gated at the top of the family (401 before any sub-path work). | The only in-app caller (OptionsFlowsHub, signed-in dashboard) already sends the session cookie. Public market quotes stay ungated per the recorded #1725 M10 decision (§6) — flows are not quotes: they serve modelled flow items, news, and filings through the app's data path. |

## 6. Deliberately ungated, with reason (F-06 + F-20, re-verified)

F-06 (authz.md §7/§10) — each item re-verified against live code;
the "ungated" in the scan row means "not PDP-gated" (or, for the
revocations, "not step-up-gated"), NOT "reachable without any
authentication". The precise gate is stated here so the shorthand
cannot be misread:

| Surface | Precise gate | Reason still true? |
| --- | --- | --- |
| E*TRADE revoke (`POST /api/etrade/oauth/revoke`) | Session-gated; NOT PDP-gated | Yes — revocation is a safety action; gating it would let the policy it escapes from block the escape. The session gate still binds it to the caller's own tokens. |
| API-key deletion (`DELETE /api/api-keys/:id`) | Session-gated; NOT step-up-gated (minting IS step-up-gated) | Yes — revocation must never be blocked by staleness; a stale session can still kill its own keys. Deletion is scoped to the session's own keys. |
| `/trade/approve` | Session-gated at the edge AND downstream DO HITL gate (draft must exist, still `previewed`, execution parameters must match the preview; stale drafts expire unexecuted) | Yes — the downstream DO gate owns the decision; the edge session gate binds it to the caller's own agent. (The authz §7 shorthand "downstream DO gate" understated the edge session gate; corrected here.) |
| Generic `/api/*` forwarder | Session-gated; NOT PDP-gated | Yes — the forwarder is session-gated and instance-scoped to the caller; PDP enforcement exists on the §1 gates and the platform-admin surfaces (§3, seam A) by design, and the forwarder is none of those. Membership/admin revocation does not deny forwarder routes (authz.md §9 residual). |
| Schedule-goal mutations (`POST/DELETE /api/schedule/goals/*`) | Session-gated (gate before the DO stub); NOT PDP-gated | Yes — same shape as the forwarder: any signed-in user may use the dashboard; no admin gate is invented here (per the route's own comment). |

F-20 (zero-trust.md §5.2) — public surfaces by design, re-verified:

| Surface | Reason still true? |
| --- | --- |
| Landing page (`/` unauthenticated) | Yes — renders the static landing page only; the SPA shell with user data is served only to authenticated sessions. |
| A2A agent-card GETs (`/.well-known/agent-card.json`, `/a2a/<agent>/agent-card.json`) | Yes — capability discovery by design; cards carry no data. Dispatch (POST) is token-gated (§4). |
| Strategy pages (`/strategies/*`) + static assets (`/assets/*`, favicon, robots, manifests) | Yes — served verbatim from the ASSETS binding without a session-store read (#329); they are static files, not data. Anything not listed keeps going through `requireAuth`. |
| `/mcp/scanner` (paid tool) | Yes for `screen_options` — x402 payment IS the access control. Nuance recorded honestly: the three free tools (§4) are not payment-gated; they expose only public market-data outputs and the shared-instance job list (§7). |
| Market quotes (`GET /api/market-data/quotes`, aliases; `WS /api/market-data/quotes/ws`, aliases) | Yes, by the RECORDED #1725 M10 decision: "market HTTP stays unauthenticated 200+unavailable" in every mode, stated as an enforcement invariant in `src/config/quoteModes.ts` ("no switch value widens access"). The response is public quotes only — no user state, no credentials. Residual in §7. |
| `/health`, `/api/health` | Yes — liveness only (status, version, timestamps, coarse subsystem health); no user data. |
| `/.well-known/oauth-client-id-metadata-document` | Yes — the Public authorization server fetches it unauthenticated by OAuth design; it publishes the client id metadata, nothing else. |
| CORS preflights (`OPTIONS` on `/mcp`, `/mcp/scanner`, `/api/premium/*`, `/api/payments/agentic/*`) | Yes — preflights return headers only and invoke no handler. |
| Login / OAuth entry points (`/login`, `/auth/login/:provider`, `/auth/callback/:provider`, `/slack/install`, `/slack/oauth_callback`) | Yes — protocol entries by design: provider callbacks verify state and bind the flow to the session (E*TRADE/Public) or exchange the code with the client secret (Slack); an unknown/disabled provider is a 403, never a fallback. |
| `/auth/logout` | Yes — logout must work even with an invalid or expired session; that is the point of the action. It records-then-deletes and never mints anything. |
| `/checkout/sandbox` | Simulated sandbox terminal page (demo HTML, no real payment). Deliberately reachable — but see the §7 observation on its unescaped query parameters. |
| Unmatched paths → ASSETS fallback | The SPA shell / static file only; no data route hides behind the fallback (every `/api/*` path is caught by the forwarder first). |

## 7. F-44 verdict: the alleged PDP bypasses

**Verdict: NOT a verified live bypass — and the premise needs
correcting.** The assessment row claims "direct endpoint invocations
in `server.ts` missing `iaaaGates.ts` middleware wrapping". On live
code:

1. **There is no `iaaaGates.ts` middleware to wrap with.**
   `src/security/iaaaGates.ts` is a 52-line leaf module holding two
   predicates (`logoutAuditTenant`, `requiresStepUpForMint`) — not
   middleware, not a wrapper, and no route is "wrapped" with it
   anywhere. The codebase's gate model is per-route calls
   (`requireAuth`, `checkRoutePermission`, `canGrantRole`,
   signature/token/payment verification), not middleware
   composition. A route cannot "bypass" a middleware that does not
   exist.
2. **Every F-44 route is therefore resolved by this inventory, not
   by wrapping:** each `server.ts` branch now has a named gate in
   §1–§6 above, including the three previously ungated routes
   closed in §5. No route is left in "unknown" status.
3. **The PDP's narrow scope is by design, not a bypass.** The PDP
   enforces the §1 gates, the grant checks, and the
   platform-admin surfaces (§3, seam A);
   session-gated routes never consult it (authz.md §9 residual).
   Calling that a "PDP bypass" would misdescribe the architecture:
   the bypass question is whether a route that SHOULD consult the
   PDP does not — and the integration routes that should, do.
4. **F-44's two carried sub-concerns (assessment, not gate
   findings):**
   - *E*TRADE token-cache invalidation races → mid-flight AUTH_003
     failures:* mitigated, not open, on live code — #1218
     invalidation epochs (`src/security/etradeTokenCache.ts`):
     readers capture the epoch when a read begins and a moved
     epoch drops the landing write, and invalidation drops all
     environment variants for the login. Residual, bounded:
     the positive cache TTL is 60 s, so a revoked token can
     still be served from an isolate's cache for up to 60 s
     after revocation — the same class of window as the
     60 s session isolate cache, not a gate bypass.
   - *Derived-identity collision/mapping-bug risk (adr/0001):*
     not a live collision on current code — the internal id is
     `v1:` + SHA-256 over `issuer + "\0" + subject`
     (`src/security/identityBinding.ts`), with the issuer in
     the input precisely so a subject alone cannot collide
     across IdPs. A collision would require a SHA-256
     collision or two IdPs configured with the same issuer
     string (a configuration fact, not a code path). The
     alias layer (zero-trust.md §5.4) still mitigates
     login-rename orphaning; that cutover remains open and is
     unchanged by this slice.

## 8. Non-HTTP entries (noted, not HTTP surfaces)

- **Scheduled handler** (`scheduled()` in `src/server.ts`):
  unattended work runs under the explicit service identity
  (`SERVICE_USER_LOGIN`), never a hardcoded synthetic login; when
  no service identity is configured, identity-bearing dispatches
  are skipped and logged (fail closed). The 03:00 UTC renewal pass
  asserts no identity and enumerates stored tokens.
- **Email handler** (`email()`): Cloudflare Email Routing
  messages, handled by `handleCloudflareEmailMessage`; not an HTTP
  route and out of this inventory's scope beyond this note.

## 9. Residuals and observations (named, not hidden)

1. **Scanner shared-instance job visibility.** `list_scan_jobs`
   lists jobs on the caller's affinity instance; callers with no
   `x-scanner-session` header share `public_scanner`, so one
   anonymous caller's paid-scan history on that instance is
   visible to other anonymous sharers. The outputs are public
   market-data results (not credentials, not user-owned private
   data), and single-job fetch needs the UUID — so this is
   recorded as a deliberate-ungated residual, not a gap closure
   by gating: inventing identity for a public paid scanner is a
   product decision for a follow-up, not this audit slice.
2. **Quotes env-mode quota.** Under `QUOTE_HTTP_PROVIDER_MODE=env`,
   anonymous quote calls can spend the owner's Alpaca quota
   (keys never leave the server; responses are quotes only).
   No throttle sits on the quote branches. This is the recorded
   M10 contract's cost, stated here so it is a decision rather
   than an accident; changing M10 is a follow-up, not this slice.
3. **`/checkout/sandbox` reflected parameters (OUT OF SCOPE,
   observed, not fixed here).** The demo page interpolates
   `provider`, `amt`, `curr`, `cust`, and `sig` query parameters
   into HTML without escaping. That is a reflected-content
   concern, not a gate-coverage gap, so this slice records it
   with file/line evidence (`src/server.ts`, `/checkout/sandbox`
   branch) and recommends a follow-up issue instead of expanding
   scope to fix it here.
4. **A2A token naming muddle (OUT OF SCOPE, observed).**
   Inbound dispatch reads `A2A_API_TOKEN` (`src/a2a/index.ts`),
   while the deploy workflow pushes a Worker secret named
   `DASHBOARD_API_KEY_IS_A2A_TOKEN` and `cfpayA2A.ts` reads
   that name for outbound calls. Whether production dispatch is
   currently 503 (unset `A2A_API_TOKEN`) or served under an
   owner-set value cannot be determined from code alone and is
   NOT asserted here; it needs a live probe and, if confirmed,
   its own follow-up. This slice deliberately did NOT reuse
   either name for the QA token, to avoid entangling a third
   purpose with an already-muddled credential.
5. **Owner activation owed by this slice.** `QA_INVESTIGATE_TOKEN`:
   create the GitHub secret and set the same value as a Worker
   secret (`wrangler secret put QA_INVESTIGATE_TOKEN`). Until
   then, post-deploy smoke investigation comments warn 401 and
   are skipped; the smoke job itself still passes.

## 10. What changed in this slice

- `src/server.ts`: gates on the three §5 routes; `timingSafeEqual`
  import for the QA token check.
- `src/types.ts`: `QA_INVESTIGATE_TOKEN` env declaration.
- `src/client/iaaaEndpointCatalog.ts`: `session-or-service-token`
  auth kind; the three routes' auth corrected from `public`.
- `scripts/qa-smoke.mjs` + `.github/workflows/deploy.yml`:
  smoke presents the QA token when provided.
- `tests/iaaa_gate_coverage_1754.test.ts`: 9 tests (Red before,
  green after — §5 pins + no-regression session paths).
- `docs/architecture/security/authz.md` §7: inventory summary +
  pointer to this file (the §7 shorthand corrected: revocations
  and the forwarder are session-gated, PDP/step-up-exempt — not
  "ungated" without qualification).
- `docs/architecture/security/zero-trust.md` §5.2: scanner
  free-tool precision (payment gates `screen_options` only).
- `changelog.d/1754-gate-coverage-audit.md`: fragment.

## 11. Amendment (GAP-1, 2026-11-18)

- The platform-admin gates in §3 (overview, telemetry mutations,
  retention purge, seed-halt, reconcile routes, canonical
  seeding) now consult the PDP at platform scope through the seam
  (`checkPlatformPermission`, `src/security/iaaaPdpSeam.ts`, GAP-1
  under #5343, CISO coordination #5350), replacing the hand-rolled
  `isPlatformAdmin` predicate. The same consultation gates the
  tenant-queue routes (`src/agents/routes/adminTenantQueues.ts`),
  KV wipe (`kvWipe.ts`), user administration
  (`platformUsers.ts`), service-user administration
  (`serviceUser.ts`), the lifecycle platform operations
  (`dataLifecycle.ts` `resolveWiredCaller`), and the SecHub
  policy/PDP/PEP/PIP branch (`src/server/routes/auth.ts`) —
  surfaces that had no §3 row before this slice; their gate is
  recorded here rather than in invented rows. Decisions are
  identical to the former predicate (live platform-admin binding
  at platform scope, unrevoked, unexpired); the permission passed
  is the platform-privilege grant (`role:assign`). Per-surface
  permission mapping is CISO follow-up, not decided here.
- The §6 forwarder row and §7 point 3 above were corrected in the
  same amendment: the "only four routes" statements predated the
  `action:approve` / `task:create` gates and seam A.

#CISO-bhdm
