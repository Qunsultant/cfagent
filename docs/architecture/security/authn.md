# Authentication — user security

How a person proves who they are to cfagent, and how that proof is carried,
checked, and refreshed. Authorization (what the proof permits) is in
[authz.md](authz.md); the end-to-end picture is in
[security-workflow.md](security-workflow.md).

## 1. Providers are plugins, not hardcoded routes

Login providers register in a provider registry
(`src/security/providers.ts`). A provider is a `LoginProvider` adapter: an
id, a display name, a protocol (`oauth` for GitHub, `oidc` for Google and
anything built on the generic factory), endpoints, env-key names, and scope.
The generic OIDC factory (`src/security/oidcProvider.ts`) builds an adapter
from endpoints plus env names plus scope, so onboarding a new provider is
one adapter plus registration plus configuration — never a new bespoke
route set. See [iaaa-provider-onboarding.md](iaaa-provider-onboarding.md);
Google is the worked example in
[iaaa-google-defaults.md](iaaa-google-defaults.md).

Routes are generic: `/auth/login/<providerId>` and
`/auth/callback/<providerId>` dispatch through the registry. The exact
`/auth/login` and `/auth/callback` paths stay GitHub-only. An unknown,
unlisted, or empty provider id is refused (403) — it never falls back to
another provider. Wiring OFF is also a 403. The login page renders one
button per enabled registered provider; shipping a provider's code surfaces
no button until it is enabled.

## 2. Identity is (issuer, subject) — never an email or a login

Slice 1 identity binding (`src/security/identityBinding.ts`) maps
`(issuer, subject)` to a stable internal user id. The rules are absolute:

- Email is never identity. For Google it is only the legacy login key, and
  login fails closed if it is missing or unverified.
- A GitHub login is never identity either: it can be renamed, and a
  released login can be recycled. GitHub sessions bind the **numeric user
  id**; a missing or non-finite id fails login. The bootstrap parser
  rejects a pasted login for the same reason.
- Sessions carry `internalUserId`, `providerIssuer`, `providerSubject`,
  `authTimeMs`, and `sessionVersion: 1`. Legacy (pre-wiring) sessions
  carry none of these: they are keyed by login string only.

`GET /api/me` returns the caller's **own** `internalUserId` for wired
sessions only. Legacy sessions get no such key, and unauthenticated callers
get `authenticated: false` with no id. The id is an identifier, not a
credential — but it is still only ever disclosed to its own session.

## 3. Session lifecycle (hardening)

Session policy (`src/security/sessionPolicy.ts`, Slice 2) is a contract,
not a set of suggestions:

- **Absolute TTL:** 7 days, **sliding on authenticated page navigation**.
  When an authenticated document load finds the 7-day window within its
  last 2 days, the server rewrites the same session record with a fresh
  `createdAt` (same session id, so every open tab stays valid) and
  re-issues the cookie. A **30-day hard cap** (`SESSION_MAX_TTL`, measured
  from `firstCreatedAt`) stops renewal: an active user is not asked to sign
  in weekly, but a session cannot live forever. The store record itself
  expires at the renewed `createdAt + SESSION_TTL`; the cap is re-checked
  on every validation, so a stale renewal cannot outlive it.
- **Idle expiry:** enforced for wired sessions, read from a **fresh**
  session read — never from the isolate cache. The window is **8 hours**
  in `config/session-limits.json` (owner override 2026-10-29 of the CISO
  30-minute default; `SESSION_IDLE_TIMEOUT_MS` remains an optional runtime
  override), so an actively-used dashboard is not signed out mid-workday.
  Legacy sessions are exempt (they carry no activity timestamp). That idle exemption is
  itself bounded by the absolute lifetime: the store record expires at
  createdAt + `SESSION_TTL` (7 days) regardless of activity, and no
  path re-puts a legacy session with a fresh TTL. The PDP exemption
  for legacy sessions has its own explicit bound ([authz.md](authz.md)
  §8, #1749) — a different rule from the idle exemption, and neither
  is open-ended.

**Config file (2026-10-29).** Every session/auth window — absolute TTL,
30-day cap, 2-day renewal window, cookie Max-Age, idle timeout, step-up
freshness, touch interval, cache TTLs/entries, OAuth state and Public
OAuth pending lifetimes — lives in `config/session-limits.json` and is
typed by `src/config/sessionLimits.ts`. No session module hardcodes a
duration. The idle value is the owner's 8-hour override of the settled
CISO 30-minute default (D-1 in
[iaaa-decisions-1757.md](iaaa-decisions-1757.md)); the refresh path also
preserves the page being refreshed (`auth:next` in sessionStorage) and
returns to it after login.
**Duplicate cookies (2026-10-29, #2271).** A browser can hold more than
one `session_id` when an older cookie differs by Domain/Path, and sends
every match. The auth path tries each UUID-shaped candidate in header
order — deduplicated and capped at `MAX_SESSION_COOKIE_CANDIDATES` (8),
so a request-controlled `Cookie` header cannot fan out SessionStore
reads — and re-issues the id that actually resolved the session. Logout
deletes every candidate. Landing, login and app-shell HTML are served
`Cache-Control: no-store`: a cached signed-out document replayed on
refresh reads as a sign-out even while the cookie is still valid.
- **Rotation and revocation:** sessions rotate, and revocation is stored
  so a revoked session stays revoked.
- **Step-up:** sensitive operations require a recent authentication.
  The default window is 15 minutes (settled CISO value, #1757); the
  per-action windows are settled by #945 Q4 (#3102): 5 minutes for
  privileged role assignment, integration-credential management
  (API-key mint is the live example, retimed from the default),
  auth-method change, provider linking, and payment-configuration
  change; 10 minutes for sensitive export. See
  `docs/architecture/security/step-up-windows-3102.md` for the full
  table, the legacy-session rule, and the deliberately ungated list.
  A step-up gate fails closed when `authTimeMs` is missing, so legacy
  sessions are stale for every step-up action until they re-login
  through wiring.

Sessions live in the SessionStore Durable Object. Bindings created by
wiring live under `iaaa-binding:` keys with no TTL; rollback of wiring
config does not delete them.

## 4. Request authentication

Every request that needs a user goes through `requireAuth` (worker) or the
DO forward path, which sets an `x-user-login` header from the session
login before forwarding. Enforcement code validates wired sessions on
fresh reads, touches activity (writes at most every 60 seconds), and
invalidates the session cache after updates — the cache is consulted only
to decide whether a session is wired at all, never to authorize.

## 5. What authentication does not do

- It does not authorize anything by itself. A valid session with no
  membership is denied at every PDP gate it reaches (see
  [authz.md](authz.md)); a legacy session inside its grace bound is
  exempt from PDP gates, which is a migration property with a
  deadline, not a privilege — past the bound it is denied at those
  gates until re-login (see [authz.md](authz.md) §8).
- It does not connect third parties. Signing in does not link E*TRADE,
  MCP, or any integration — each of those is a separate, separately
  gated authorization (see [etrade.md](etrade.md) and
  [api-security.md](api-security.md)).
- It does not survive renaming unscathed. Token and DO state keyed by
  login string can orphan on rename; the IAAA alias layer dual-reads
  internal id first, login second, but the cutover beyond aliases is
  still open (see [authz.md](authz.md)).

## 6. Configuration that controls authentication

| Setting | Effect |
| --- | --- |
| `IAAA_WIRING_ENABLED=1` | Wiring on; default off |
| `IAAA_ENABLED_PROVIDERS` | Comma list of enabled providers; default `github` when wiring is on |
| `IAAA_TENANT_ID` | Tenant; default `"primary"` (see [authz.md](authz.md)) |
| `IAAA_BOOTSTRAP_ADMINS` | Bootstrap entries; blank means zero entries, zero error |
| `IAAA_PDP_ENABLED=1` | PDP denials on; default off |

All are plain config in `wrangler.jsonc` vars (identifiers and switches,
not credentials). Provider client secrets are never committed: they travel
GitHub PROD secrets → deploy sync → Worker secrets. Rollback of any of
these is a config change plus redeploy.

## 7. Authentication models supported — and not supported

cfagent supports exactly one authentication model at the app level:
**federated social login** — GitHub (OAuth) and Google (OIDC) through
the provider registry (§1). There is no local password login, and the
codebase contains no app-level TOTP, WebAuthn/passkey, magic-link, or
passwordless implementation. That is a deliberate consequence of
federation, and it draws a sharp line:

| Model | Status at cfagent |
| --- | --- |
| Social login (GitHub, Google) | Supported — the only app-level models |
| Two-factor authentication (2FA) | **Inherited from the IdP, not implemented by the app.** If a user's GitHub or Google account enforces 2FA (or passkeys), that enforcement happens at the IdP during login, and cfagent trusts the IdP's assertion via the OAuth/OIDC code exchange. The app never sees the second factor and cannot waive it |
| Passwordless (passkeys, magic links) | Same as 2FA: available **transitively** when the IdP offers it (a user may sign in to Google with a passkey), but cfagent offers no passwordless method of its own |
| Local passwords | Not supported — there is no password store, no password login route, and nothing to reset |
| App-level TOTP / WebAuthn / magic links | Not implemented (no code paths exist) |

Do not confuse step-up with 2FA. Step-up (§3) is a **freshness**
requirement (recent `authTimeMs`), not a second factor: it proves the
same authentication happened recently, not that a second channel
confirmed it. It does not exist today, and any
doc or claim that cfagent "supports 2FA" must say "via the IdP" or not
say it at all.

> **Decision record — 2026-10-27 (owner decision, #1752): OUT.**
> App-level TOTP, WebAuthn/passkey, and magic links are out of scope:
> no app-level factor code is built under #1752, and none follows
> from it. Two-factor authentication remains inherited from the IdP,
> and any "supports 2FA" claim must say "via the IdP". Step-up (§3)
> remains a freshness requirement, not 2FA. The earlier hypothetical
> sentence in this section ("a deployment that needs app-level 2FA
> would add it…") is superseded by this record and must not be read
> as an open authorization: any future app-level factor work would
> require a NEW owner decision and a NEW issue, not #1752.

Email plays no role in app authentication: there is no email-code
login, no email-based recovery, and no email verification step in the
app's own flow (Google's email-verified requirement is the IdP
asserting its own verification, not the app sending a code). Email's
role in this system is communications and trading workflows, covered in
[email-communications.md](email-communications.md).
