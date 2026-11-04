# Deep-link return after sign-in (#3015)

A signed-out visit to a bookmarked in-app URL must land back on that
page after sign-in, through any provider, across a provider switch,
and after a session-expiry bounce — never on an arbitrary default
page, and never off-site.

## The gap it closes

Before this slice, the sign-in flow carried no return target at all
(`returnTo` / `return_to` = 0 hits on main). A signed-out visit to
`/?tab=products` was served the landing page, whose sign-in links
went to the plain `/login` page, whose provider buttons went to plain
`/auth/login/<id>` — and the post-login redirect was always the
default landing. The bookmarked page was lost at the first hop.

(A client-side `auth:next` sessionStorage restore already covered
one narrow path — the app-shell boot redirecting straight to
`/auth/login/github` — but it never ran for the landing-page
journey, never survived a provider switch through `/login`, and
never worked with sessionStorage unavailable.)

## How the target travels

One mechanism, end to end, with validation at every use:

1. **Capture.** A signed-out deep-link visit is served the landing
   page; its sign-in links carry `?target=<validated path + query>`
   (`src/client/landing.ts`). The SPA boot redirect to
   `/auth/login/github` carries the same parameter, including the
   hash (`src/client/main.tsx`). A direct `/login?target=...` visit
   works the same way.
2. **Buttons.** The `/login` page embeds the validated target in
   every provider button (`src/security/githubOAuth.ts`), so
   switching providers mid-flow — GitHub → back to `/login` →
   Google — keeps the same target: each button seals it into its
   own signed state.
3. **Signed state.** `startLogin` seals the target into the OAuth
   state (`src/security/session.ts`): the plain form stays
   `random.timestamp.sig`; a target-carrying state is
   `random.timestamp.base64url(target).sig`, with the signature
   covering the target segment. A refused target starts a plain
   login instead — it never blocks sign-in. For Apple, the state
   IS the nonce, echoed back verbatim, and `response_mode=query`
   returns code + state as query parameters, so the existing
   callback path handles Apple identically.
4. **Callback.** `handleCallback` verifies the state, recovers the
   target from it, and passes it to the wired tail
   (`src/security/oidcProvider.ts`). No raw query parameter is ever
   trusted at callback time — only the signed state.
5. **Landing.** The wired tail redirects to the target with the
   `signed_in` outcome appended (`src/security/iaaaLogin.ts`), so
   the boot toast still shows and the parameter is still stripped
   on boot. An absent or invalid target keeps exactly the default
   landing.

## Validation rules (`src/security/returnTarget.ts`)

A target is returned normalized, or refused (null) — and every
refusal fails closed to the default landing, never to an error
page, never off-site:

- Only relative URLs. Anything that parses as absolute (any
  scheme, protocol-relative `//host`) is refused, even a
  same-origin absolute URL — our own callers always build
  relative targets.
- Auth routes are never valid targets: `/login`, `/login/*`, and
  `/auth/*` are refused, so a target can never loop back into
  the auth flow.
- Raw control characters and backslashes are refused outright.
- Absurd input is refused (empty, blank, over 2048 chars).
- The outcome parameter is stripped from the target, so a saved
  return page never carries an outcome (#2402 rule).
- Unknown in-app paths are NOT refused: a same-origin relative
  path can only ever land on this app, where the SPA's own
  routing handles it.

## Session-expiry bounces

An expired session funnels through the same two entry points, so
no separate expiry path was needed: a refresh after expiry serves
the landing page for the current URL (whose sign-in links carry
it), and the app-shell boot redirect carries it as `?target=`.
The just-created-but-unreadable edge (`session_unreadable`)
preserves a deep link too: that redirect carries `?target=` when
the request URL is a real deep link, and stays byte-identical
for a plain visit.

## The boot restore guard (`src/client/main.tsx`)

The pre-existing `auth:next` restore now runs ONLY on the default
landing (`isDefaultLandingUrl` in `src/client/authOutcome.ts`).
After a target-carrying callback the URL already IS the
bookmarked page, and a stale saved page must never clobber the
server-chosen target. On the default landing the restore behaves
exactly as before.

## Known limitation: fragments

A fragment (hash) survives only when a client-side caller can see
it and percent-encode it into the target — the SPA boot does
exactly that. The landing-page leg cannot carry a fragment: the
browser never sends it to the server, so that leg carries path +
query only. This is a browser limitation, not a design choice,
and the signed-state segment itself preserves a fragment whenever
one is supplied.

## What did NOT change

- No-target behavior is byte-identical: the plain login page,
  the plain landing page, the plain startLogin state (3 parts),
  and the default post-login redirect are all unchanged.
- No new stores, no new endpoints, no new scheduled work, no
  behavior change to sessions, bindings, audit, or the PDP.
- No file was deleted.
