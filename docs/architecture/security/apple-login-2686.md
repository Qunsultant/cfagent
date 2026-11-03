# Sign in with Apple (#2686)

Apple as a login provider alongside Google and GitHub, through the
existing generic OIDC/OAuth2 login-provider factory
(`src/security/oidcProvider.ts`) and the #945 IAAA wiring behind
`IAAA_WIRING_ENABLED`. No Apple-specific login path exists parallel
to the generic one: Apple is one declarative `createOidcProvider`
call in `src/security/providers.ts`, and its genuine deltas are
factory options.

## What ships

- **Registration**: provider id `apple`, issuer
  `https://appleid.apple.com`, OIDC protocol, display name `Apple`.
  Authorization endpoint `https://appleid.apple.com/auth/authorize`,
  token endpoint `https://appleid.apple.com/auth/token`, scope
  `name email`, subject field `sub`, login-key field `email`,
  `requireEmailVerified: true` (same as Google).
- **Surfacing**: the login page renders one button per enabled,
  registered provider. Adding `apple` to `IAAA_ENABLED_PROVIDERS`
  shows the "Sign in with Apple" button when wiring is on; wiring
  off hides it. The button is never ungated, and the wiring flag is
  the rollback lever (same as Google).
- **Session, alias, tenant, audit**: the generic wired tail
  (`completeWiredLogin`) — same session lifecycle, same wired-login
  alias, same tenant binding and auto-provisioning, same login
  success/failure audit events as Google/GitHub. Logout is the
  existing session-invalidation path with its audit hook; login via
  Apple grants no admin role by itself (owner clarification on
  #2686), like every other provider.

## Apple deltas (all factory options, not a parallel path)

### No userinfo endpoint: profile from the ID token

Apple has no userinfo endpoint. The profile comes from the token
response's `id_token` (`profileFromIdToken`), decoded by the
factory. **Trust model, stated plainly**: the token is decoded,
not signature-verified. The id_token arrives from Apple's token
endpoint over TLS as the result of this server's confidential code
exchange (code + minted client secret) — exactly the trust the
userinfo fetch has always relied on for Google/GitHub. No endpoint
accepts a client-supplied id_token, so a forged token alone cannot
create a session. Full JWKS signature verification is a later slice
if wanted, and would apply to Google's (currently ignored) id_token
too, for consistency — it is not smuggled in for one provider.

### Nonce bound to the login attempt's state

The authorize request carries `nonce=<state>`
(`useStateAsNonce`), and the callback verifies the id_token's nonce
claim against the already-verified signed state. The state's random
UUID is the per-attempt unpredictable value, so no new nonce store
and no state-format change was needed. A nonce without an ID-token
profile is a misconfiguration and fails closed at start.

### Response mode: query, not form_post

The authorize request sets `response_mode=query`
(`extraAuthorizeParams`). Apple's `user` name payload (first
authorization only) arrives only via `form_post`, which this slice
does not use: supporting it would need POST callback handling for
all providers. Consequence, by design: no Apple name is ever
captured, the display name falls back to the login key (the
normalizer's existing fallback), and **no flow depends on
re-reading a name later** — satisfying the issue's name rule by
construction. Capturing the first-authorization name via form_post
is a possible later slice, not built work.

### Client secret: minted per exchange, never stored

Apple's token endpoint requires an ES256 JWT (iss = Team ID, sub =
Service ID, aud = `https://appleid.apple.com`, expiry at most 6
months out). `src/security/appleClientSecret.ts` mints it on demand
at exchange time (`clientSecretResolver`) from the owner-set env
(`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_CLIENT_ID`).
Default minted lifetime is 1 day, far below Apple's 6-month maximum.
A missing input or bad key makes the resolver return undefined, and
the credentials gate fails the login closed — never a redirect to
a flow that cannot complete.

## Private email relay: email is never identity

A user who hides their email gets a relay address
(`@privaterelay.appleid.com`). Identity is the Slice 1 binding
(`https://appleid.apple.com`, `sub`) — never the email. The email
is only the adapter-supplied legacy login key (session display
fields, alias record). A relay→real email change for one subject
resolves to the same internal user (pinned by test: two logins,
one relay, one real, same subject → same `actorPrincipalId` on
both login-success audits). No flow keys on email, and a relay
address is never treated as a real, stable address.

## Revocation: nothing to revoke (by construction)

The factory retains no provider tokens: the access token is used
once (for the exchange that yields the id_token) and discarded, and
no refresh token is stored. Apple's revocation endpoint
(`https://appleid.apple.com/auth/revoke`) therefore has nothing to
revoke on logout — logout is session invalidation, same as every
provider. If token retention is ever added, revocation must be
added with it; that coupling is recorded here so a future slice
cannot retain tokens without a revoke path.

## Client-secret rotation story (who rotates what)

- **The .p8 private key does not expire.** Only minted JWTs do, and
  they are minted per exchange with a 1-day lifetime — there is no
  stored secret that can silently expire and break sign-in.
- **Owner rotates the key** (the only rotation event): generate a
  new key in Apple Developer → update the `APPLE_PRIVATE_KEY`
  Worker secret (dashboard or `wrangler secret put`) → deploy →
  verify an Apple sign-in. No downtime: the next exchange mints
  with the new key. Then revoke the old key in Apple Developer.
- **Operator-minted secrets** (if anyone pre-mints a secret for a
  non-Worker caller): check it with `getAppleClientSecretExpiry`
  before use — `ok` / `expiring-soon` (under 30 days) / `expired` /
  `invalid`. Never deploy a secret in `expiring-soon` without a
  rotation date.
- **Blast radius of a key rotation**: Apple sign-in only, until the
  new secret is live; existing sessions are unaffected (sessions
  do not depend on the provider secret).

## Enablement (owner steps, in order)

1. Apple Developer: create a Service ID (the `APPLE_CLIENT_ID`),
   a key (the `APPLE_KEY_ID` + `.p8` private key), and note the
   Team ID. Configure the Service ID's return URL as
   `<APP_BASE_URL>/auth/callback/apple`.
2. Set the Worker secrets (dashboard or `wrangler secret put`):
   `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`,
   `APPLE_PRIVATE_KEY` (PEM content, never committed).
3. Add `apple` to `IAAA_ENABLED_PROVIDERS` (with
   `IAAA_WIRING_ENABLED` on) and deploy.
4. **Live proof (owner step, not lane-verifiable)**: sign in with
   Apple in production and confirm the session + tenant membership.
   Until that confirmation, this slice is wiring-verified (tests,
   gate, deploy) but not live-proven — exactly like #2889's send
   confirmation. A live sign-in must never be faked in a report.

## Out of scope (later slices, not built work)

- Cross-provider account linking (an Apple login and a Google login
  are separate identities today, by the subject-keyed design).
- First-authorization name capture via `form_post` callbacks.
- JWKS signature verification of ID tokens (would apply to Google
  too, for consistency).
- Any app-level second factor (per the #1752 OUT decision, 2FA
  stays with the IdP). Apple 2FA, when the user's Apple ID has it,
  is the IdP's, not the app's.
- Migrating existing users between providers.
- Changing the #945 provider/framework/tenant decisions (APP-OWNED /
  FOSS / APP-OWNED, unchanged).

## Tests

`tests/iaaa_apple_provider.test.ts` (20 tests): registration pins
and config gating; mint claims + signature verification with a
runtime-generated keypair + expiry-detector statuses; the factory
ID-token flow end to end (start params incl. nonce=state and
response_mode=query; callback success with exactly one upstream
call; relay→real identity equivalence; nonce mismatch, missing
id_token, unverified email, and missing subject all fail closed;
nonce-without-profile misconfiguration; resolver-supplied secret).
