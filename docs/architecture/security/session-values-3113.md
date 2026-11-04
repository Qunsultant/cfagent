# Session values — #945 Q5 settlement (issue #3113)

This document records the settled session values for the IAAA epic
(#945), assurance review §4 Q5. It settles policy; it does not rewrite
the PROPOSED spec (`docs/plans/IAAA-945-spec.md`) or the DRAFT assurance
review (`docs/architecture/security/iaaa-945-assurance-review.md`) —
that refresh is Q11. Q4's action freshness windows (5/10/15 minutes)
are a different quantity: they bound how fresh an authentication must
be for a privileged *action*. This document bounds the *session*
itself. Nothing here re-litigates Q4.

Single source of truth for the numeric values: `config/session-limits.json`
(documented in `src/config/sessionLimits.ts`). Where a value below says
"pin", the named test asserts it; a future change to the value must
update the pin in the same PR (gitops §7 pin rule).

## Settled values

### Absolute TTL: 7 days, sliding (604800 s)

A session record lives 7 days from its last renewal. `createSession`
stores at this TTL; `renewSessionWithStore` slides `createdAt` forward
on renewal. Rationale: a week of unattended validity is the usability
ceiling for a dashboard session; the 30-day cap below is the hard
backstop, so the sliding window cannot extend a session indefinitely.

- Enforced: `src/security/session.ts` (`createSession`,
  `renewSessionWithStore`); `src/security/iaaaLogin.ts`
  (`getValidatedSession`).
- Pin: `tests/iaaa_session_values_3113.test.ts` (7d absolute + 2d renew).

### Renew window: 2 days (172800 s)

A session becomes eligible for renewal 2 days before its absolute
expiry; renewal is refused once the lifetime cap is reached (see next).
Rationale: renewal well before expiry avoids mid-work logouts, while
the 2-day window keeps the renewal decision close enough to expiry
that a stolen session cannot be kept alive by renewal alone — renewal
slides `createdAt` but never `firstCreatedAt`.

- Enforced: `src/security/session.ts` (`sessionRenewalDue`).
- Pin: `tests/iaaa_session_values_3113.test.ts`.

### Maximum lifetime cap: 30 days from first login (2592000 s)

No session, however often renewed, survives 30 days past
`firstCreatedAt`. This is the outermost bound: `sessionExpiryReason`
checks it FIRST, before absolute and idle expiry, and production
enforcement (`getValidatedSession`) applies it with a `createdAt`
fallback for legacy sessions that predate the field. A session that
hits the cap must re-authenticate; rotation does not extend it
(rotation preserves `firstCreatedAt`).

- Enforced: `src/security/sessionPolicy.ts` (`sessionExpiryReason`,
  code `LIFETIME_EXPIRED`), `src/security/iaaaLogin.ts`
  (`getValidatedSession`, `SESSION_EXPIRED` "session passed its
  30-day lifetime cap").
- Pin: `tests/iaaa_session_values_3113.test.ts` (30d cap);
  `tests/iaaa_session_rotation_3113.test.ts` (cap-expired sessions
  are skipped, never resurrected).

### Cookie Max-Age: 7 days (604800 s), matching the absolute TTL

The session cookie (`session_id`) carries `HttpOnly; Secure;
SameSite=Lax; Path=/; Max-Age=604800`. The cookie lifetime matches
the record TTL so a cookie never outlives the session it names, and
clearing the cookie uses `Max-Age=0`. Rationale: `SameSite=Lax` is
the baseline cross-site defense (see the CSRF section — it is a
layer, not the whole rule); `HttpOnly` keeps the session id out of
client JavaScript; `Secure` keeps it off plaintext transport.

- Enforced: `src/security/session.ts` (`setSessionCookie`,
  `clearSessionCookie`).
- Pin: `tests/iaaa_session_values_3113.test.ts` (cookie attributes +
  7d Max-Age + clear Max-Age=0).

### Idle window: 8 hours (28800000 ms), operator override clamped to [5 min, 7 days]

A session with recorded activity expires after 8 hours without
activity. The operator override `SESSION_IDLE_TIMEOUT_MS` is clamped
to a 5-minute floor and a 7-day ceiling; an invalid value falls back
to the 8-hour default. Sessions without recorded activity are
idle-exempt (they predate activity tracking; the absolute and cap
bounds still apply). Rationale: 8 hours covers a working day without
forcing a mid-day re-login, while still bounding a session left open
on an unattended machine. The 5-minute floor prevents an operator
typo from logging everyone out mid-keystroke; the 7-day ceiling
prevents the override from silently defeating the absolute TTL.

- Enforced: `src/security/iaaaLogin.ts` (`getValidatedSession`,
  idle branch), `src/security/iaaaEnforcement.ts` (override
  resolution). Idle enforcement reads fresh (`getSession`, not the
  cache) so a stale cache entry can never extend an idle session.
- Pin: `tests/iaaa_session_values_3113.test.ts` (8h idle + override
  clamping: invalid → 8h; 1000 ms → 5 min floor; huge → 7d ceiling).

### Touch interval: 300 s

`lastActivityMs` advances at most once per 300 seconds per session.
Rationale: per-request activity writes would multiply SessionStore
rows-written against the free-tier quota behind #1819; a 5-minute
granularity is fine for an 8-hour idle window.

- Pin: `tests/iaaa_session_values_3113.test.ts` (touch 300 s).

### In-isolate session-cache TTLs: 60 s positive, 10 s negative, 2,000 entries

Within one isolate, a resolved session is cached 60 seconds and a
failed resolution 10 seconds, bounded at 2,000 entries. Cached copies
serve up to 60 seconds stale — stated here as a tolerance, not exact
enforcement: revocation propagation is therefore bound by the #1750
target (0 ms same-isolate, ≤60 s cross-isolate stale cache), and
idle enforcement bypasses the cache entirely (see above).

- Pin: `tests/iaaa_session_values_3113.test.ts` (60 s/10 s/2,000).

### Tolerances, stated as tolerances

Two quantities are tolerances, not exact enforcement, and must never
be quoted as guarantees:

- **±60 s cache staleness.** A cached session copy may serve up to
  60 seconds stale (see cache TTLs above).
- **±300 s touch slack.** `lastActivityMs` is accurate only to the
  300-second touch interval, so an idle deadline computed from it
  carries up to 5 minutes of slack. Q4's step-up windows are exact
  arithmetic on `authTimeMs`; the ±60 s tolerance that belongs to
  idle enforcement is never folded into them.

### OAuth state: 10 minutes, 60 s future skew

The OAuth `state` value (which also carries the #3015 return target
in its signed form) is valid for 10 minutes; a 60-second future skew
absorbs clock differences between the browser round-trip and the
server. Rationale: 10 minutes covers a slow provider round-trip
without leaving a usable state token lying around for long.

- Pin: `tests/iaaa_session_values_3113.test.ts` (10 min + 60 s skew).

### Session-cookie candidates: 8

The auth path accepts at most 8 `session_id` cookie candidates
(`MAX_SESSION_COOKIE_CANDIDATES`). Rationale: browsers can accumulate
stale session cookies across logins; capping the candidate list
bounds the lookup work per request while still accepting every
plausible live cookie.

- Pin: `tests/iaaa_session_values_3113.test.ts` (candidate cap 8).

### Per-user concurrent cap: 10 active sessions, oldest-out (#2840)

A user may hold at most 10 concurrent active sessions; the 11th
login evicts the oldest. Listing or eviction failure fails closed
with `session_limit_unavailable`. Cross-login visibility and
dedup are per kind. This value was settled by #2840 and is recorded
here, not re-decided, because Q5's answer is incomplete without it.

- Enforced: #2840 implementation; pin lives in #2840's tests.
- Pin (Q5 record): `tests/iaaa_session_values_3113.test.ts`
  (per-user cap 10).

### Login and logout

Every login mints a fresh `crypto.randomUUID()` session id — ids are
never reused across logins, so provider (re)linking, which flows
through login, rotates by construction. Logout revokes server-side
(`deleteSession`), not only by deleting the client cookie; a
logged-out id is dead even if the cookie survives.

## CSRF rule for mutations (new in this slice)

Before this slice there was no CSRF token mechanism for
cookie-authenticated mutations anywhere in `src/` — only OAuth
`state` for the login leg. Mutations relied solely on `SameSite=Lax`.
That was the gap Q5's sufficient answer (R7) names, and this slice
closes it.

### Model: double-submit token

The token is a random UUID minted at login and stored in a cookie
named `csrf_token` that is readable by client JavaScript **by design**
(it is NOT `HttpOnly` — the client must read it to send the header),
`Secure`, `SameSite=Lax`, `Path=/`, 7-day `Max-Age`. Double-submit
was chosen over a synchronizer token to avoid an extra SessionStore
read per mutation (the free-tier rows-read quota behind #1819).
The token is never rotated mid-session: parallel requests would race
a rotation. Pre-slice sessions (no token cookie) self-heal: any
authenticated response that lacks the cookie re-issues one
(`ensureCsrfCookie`), so the next page load fixes the session
instead of failing every mutation until re-login.

- Enforced: `src/security/csrf.ts` (`setCsrfCookie`,
  `ensureCsrfCookie`); issuance at login in
  `src/security/iaaaLogin.ts` and on `/api/me` in `src/server.ts`.
- Pin: `tests/iaaa_csrf_3113.test.ts` (`setCsrfCookie` attributes
  incl. NOT `HttpOnly`).

### Gate: state-changing methods with a session cookie need the header

A request with a state-changing method (POST/PUT/PATCH/DELETE) that
carries a session cookie must carry `X-CSRF-Token` equal to the
`csrf_token` cookie value, else 403 `csrf_invalid` before any route
work. The gate is pure (no store reads) and sits in `handleFetch`
immediately after the static-asset early return, before throttle and
routing. Safe methods pass. Requests without a session cookie pass:
Bearer/API-key/MCP callers carry no ambient credential, and the auth
layer still rejects unauthenticated callers.

- Enforced: `src/security/csrf.ts` (`csrfGateResult`); wired in
  `src/server.ts`.
- Pin: `tests/iaaa_csrf_3113.test.ts` (pure gate matrix: no token,
  mismatched token, header without cookie, matching pass, safe
  methods pass, no-cookie pass, exempt paths pass, PUT/PATCH gated);
  `tests/iaaa_csrf_routes_3113.test.ts` (worker-fetch: grant route
  403s without a token, mismatched token 403s, matching token passes
  the gate and then fails the PDP deny — a different message, proving
  the gate is not what stopped it; GET with cookie and no token is
  not csrf-rejected; Bearer-only POST is not csrf-rejected).

### Exempt paths

- `/auth/*` — no session exists yet when login starts, and the OAuth
  `state` covers the callback leg. The gate must never block the
  login flow itself.
- `/nlq/webhook`, `/api/nlq/webhook`, `/api/trading/nlq/webhook` —
  HMAC-signed, not cookie-authenticated.
- `/mcp` and `/mcp/*`, `/a2a/*` — token-authenticated, not cookie.
- `/slack/events` — signature-verified.
- GET logout (the plain link in `src/client/Chat.tsx`) is exempt by
  method. Logout-CSRF terminates a session only, the termination is
  server-revoked, and the victim re-logs in; that impact is accepted
  here, with conversion to POST logout recorded as a named
  follow-up (not built in this slice).

### Client migration (lands with the gate)

The gate and the full client migration land together — a gate without
migration would 403 every existing client mutation. Coverage:

- `apiFetch` (all callers, including every `apiFetch as fetch` alias)
  injects the header for non-GET requests via `withCsrfInit`.
- Direct-fetch funnels (`scheduleApi`, `jobsApi`, `commercialApi`,
  `refundFlowApi`, `refundPolicyApi`, `firstRunApi`,
  `socialPostingApi`, `StoreOperatorsPanel.callJson`,
  `ProductCatalogPanel.postJson`,
  `PaymentWorkflowAssurance.liveCall`) wrap their init with
  `withCsrfInit`.
- Direct-fetch single sites spread `csrfHeaders()` into their
  headers (`memoryApi`, `serviceUserApi` provision — which stays a
  raw fetch deliberately, because `apiFetch`'s 202 polling would hide
  the queued state that UI must render — `tenantProviders`,
  `DlqPanel`, `PlatformAdminPage`, `PlatformAdminPanel`,
  `PaymentsPage`, `StrategyReviewPanel`, `RunDetailView`,
  `replayReport`, `autoRefresh`, `AskAgentWidget`,
  `AutopilotControlCenter`, `ResearchRunsPanel` mutations).
- A post-migration audit (balanced-paren scan of every client fetch
  call) confirms zero unpatched cookie-authenticated mutation sites
  remain; GET-only loads need no token.

### Residual, stated honestly

Double-submit protects exactly the cross-site-request case, alongside
`SameSite=Lax`. It does not protect against XSS (an injected script
reads the readable cookie) or against a hostile subdomain setting
cookies. Those threats are out of this rule's scope; the readable
cookie is the price of the double-submit model, and it is the reason
the session cookie itself stays `HttpOnly`.

## Rotation triggers (new in this slice)

Before this slice, `rotateSession` existed and was tested but had
zero production callers: no session was rotated on privilege change
or auth-method change. This slice wires the trigger.

### Rule

After a successful role/membership grant or revoke, every ACTIVE
session of the affected user rotates: the old id is revoked and a
rotated copy is registered with `createdAt`, `firstCreatedAt`, and
`authTimeMs` preserved. Rotation is NOT re-authentication and does
NOT extend absolute expiry; only the idle clock resets. Expired
sessions are skipped, never resurrected. Other users' sessions and
legacy sessions (no `internalUserId`) are untouched. Active means
the production rules: absolute 7d from `createdAt`, 30d cap from
`firstCreatedAt` (fallback `createdAt`), idle 8h only when activity
was recorded.

### Trigger sites (8, all after success)

`role-grants/grant` (affected user = `targetId`),
`role-grants/revoke` (`record.internalUserId`),
`membership/grant` (`targetId`), `membership/revoke`
(`record.internalUserId`), `membership/edit`
(`granted.membership.internalUserId`), access-request decide
approve-grant (`existing.requesterInternalUserId`, only when
`approvedGrant` is true — denials and already-admin no-ops rotate
nothing), `permission/deny` (`targetId`), `permission/clear`
(`targetId`). Idempotent no-ops skip rotation because no privilege
change happened. Deactivation/offboarding needs no rotation:
revocation supersedes it. Bootstrap-proposals/approve applies list
changes out-of-band, not a membership grant in-request, so it is not
a trigger site.

Each trigger adds `sessionRotation: { rotatedCount, unavailable }`
to the success body. When the session listing is unavailable (the
SessionStore list restriction), the grant still succeeds and the
response says `unavailable: true` with a server warning — rotation
is never silently skipped. Responses carry counts only, never
session ids: new ids are live credentials.

### Acting-session re-issue and the other-browsers note

When the acting session itself rotated (a rotated old id matching a
request cookie candidate — `requireAuth` resolves from the same
candidate list), the route re-issues its cookie in the response, so
the actor is not logged out by their own grant. Other browsers
holding the old id are effectively logged out and sign in again.
The security property (the old id is dead after the privilege
change) holds in both cases; the rotated copy only helps a browser
that receives the new id.

### Auth-method change rule

There is no in-app auth-method-change route (established by Q4).
The settled rule is: every login mints a fresh id, so provider
(re)linking — which flows through login — rotates by construction.
Any future auth-method-change route MUST call `rotateUserSessions`
(`src/security/sessionRotation.ts`). No such route is invented here.

### Test coverage and a recorded decision

- `tests/iaaa_session_rotation_3113.test.ts` (6 tests, pure core):
  preserves expiry/auth times, other users untouched,
  absolute-expired skipped, 30-day-cap skipped, idle-expired
  skipped, legacy skipped.
- `tests/iaaa_session_rotation_env_3113.test.ts` (3 tests, env
  adapter): null listing → unavailable; UUID filter + bad-JSON
  skip + preserved timestamps through the adapter; acting-cookie
  re-issue only when the acting session rotated.
- Recorded decision: no worker-fetch rotation test exists, and that
  is deliberate. The shared fake session store restricts `list` by
  design (#1758, mirroring the real SessionStore DO rule), so a
  worker-fetch test through the existing harness would only ever
  exercise the unavailable path; building a parallel list-capable
  namespace plus a PDP-allow fixture would fake the authorization
  layer to prove the trigger. The trigger sites are wired in
  `src/server.ts` (each call site is a one-line
  `rotateUserSessionsForEnv` invocation after success), the core
  and the adapter are pinned above, and the unavailable surfacing
  is pinned at both seams.
- Pre-existing route tests updated in this slice: the gate is a new
  rule, so 22 worker-fetch test files that POST with a session
  cookie but no token failed with 403 `csrf_invalid` — the gate
  firing before the behavior under test, exactly as designed. Each
  file's request helper now sends the matching test token
  (`csrf-test-token` cookie + header), preserving the test's
  original intent (route logic, auth, PDP) under the new rule. No
  test asserted CSRF absence before this slice because no CSRF rule
  existed; no expectation was weakened, only the request completed
  to the behavior it was written to test.

## What this slice deliberately does not change

- Q4's action freshness windows (5/10/15 min) — not session
  lifetimes, not re-litigated, not asserted in the Q5 pin tests.
- The frozen #1751 `OBLIGATION_POLICY` — untouched.
- The #2840 per-user cap value (10) — recorded, not re-decided.
- No route is added for auth-method change, POST logout, or
  audit-export download; each is a named follow-up where it appears
  above, not a silent omission.
- No file is deleted; the two stale comments fixed in files touched
  (`sessionPolicy.ts` "settled 30-minute default" →
  "settled 8-hour config default"; `iaaaEnforcement.ts` "default 30
  minutes" → "settled 8-hour config value") are comment-only
  corrections to values this slice settles.

## Follow-ups (named, not built here)

- POST logout conversion (logout-CSRF hardening beyond the accepted
  risk above).
- Service-token mint/rotate `authTimeMs` threading through the
  orchestrator DO dispatch (carried from Q4).
- A future auth-method-change route must call `rotateUserSessions`
  (rule above).
- Live proof is an owner step, as always: no production session
  behavior is claimed verified beyond the tests and the post-merge
  Deploy check that gates the §15.
