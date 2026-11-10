# API security

How the HTTP surface is protected: dispatch order, per-route gating, API
keys, and the docs routes. The underlying identity and authorization
models are in [authn.md](authn.md) and [authz.md](authz.md).

## 1. Dispatch order is a security property

The worker's `handleFetch` does not treat routes equally. Order matters,
and it is deliberate:

1. **Static assets first.** The asset layer serves files before any
   session check (`serveStaticAsset`, `src/security/staticAssets.ts`).
   The `run_worker_first` list is exactly `["/", "/index.html"]`: only
   those paths invoke the Worker for unauthenticated visitors (to render
   the landing page). Everything else under the asset layer never reaches
   auth code — which is why strategy pages in `public/strategies/` are
   public by deployment, not by policy (see §5).
2. **Public routes before auth.** A2A agent-card GETs
   (`/.well-known/agent-card.json`, `/.well-known/agent.json`) are routed
   before authentication, by design: discovery is public.
3. **Session-gated routes.** The bulk of `/api/*`, the OAuth routes, and
   the admin overview go through `requireAuth` and, where applicable,
   the PDP.
4. **The generic `/api/*` forwarder last.** Anything not matched earlier
   falls to the forwarder, which is itself session-gated — an unmatched
   path is not an unauthenticated path.

A future framework adapter must preserve this order exactly (see the
#1024 conformance-suite idea): a route that moves above the session
check in a refactor has silently become public.

## 2. Per-route gating, as it stands

| Surface | Gate |
| --- | --- |
| E*TRADE link start + verifier | Session + PDP `integration:connect` (wired, PDP on) |
| E*TRADE status / renew | Session, own login only |
| E*TRADE revoke | Session, deliberately ungated (safety action) |
| `GET /api/iaaa/overview` | Platform-admin, server-side; 401/403/500 per §6 of [authz.md](authz.md) |
| `GET /api/me` | Deliberate quirk: returns `{authenticated: false}` without a session (HTTP 200), and the caller's own `internalUserId` only for wired sessions |
| `/openapi.json`, `/api/docs` | Provisional spike gating: authenticated session required (401 otherwise, 405 non-GET). The final `DOCS_PUBLIC_SURFACES` decision is still open (#1024) |
| Generic `/api/*` forwarder | Session-gated; downstream DO checks apply per route |
| WebSocket routes (`/voice/trade`, market-data quote streams) | Session handling at upgrade; they do not map cleanly onto framework middleware and stay in `handleFetch` during any strangler migration |

Per-route throttling exists as a helper in the worker dispatch; it is a
load control, not an authorization control, and must not be cited as one.

## 3. API keys

API keys are the non-session credential for programmatic access (notably
the MCP transport — see [mcp-security.md](mcp-security.md)):

- **Mint is step-up gated.** Creating a key requires a fresh
  authentication; stale and legacy sessions get a 403 until they
  re-login. Minting is the one key operation where freshness is the gate.
- **List and revoke are deliberately ungated** by step-up: revocation
  must never be blocked by the freshness rule it escapes from.
- Keys are bearer-equivalent: possession is access within the key's
  scope, so key storage and rotation are the owner's responsibility, and
  a leaked key is revoked, not "fixed" by policy.

## 4. Errors must not leak

The Worker entrypoint is wrapped in `withErrorBoundary`: an escaped throw
becomes a real 5xx with a machine-readable code, never a Cloudflare edge
error page and never a stack trace to the visitor. Corrupt-store paths
return generic 500s (the admin overview is the worked example). Error
codes are externalized (`src/aspects/errorCodes.ts`) so a message never
has to carry internals to be actionable.

## 5. Already-public surfaces (not vulnerabilities, but not secrets)

These are public and must not be treated as protected by obscurity:

- The landing page (server-rendered for unauthenticated visitors).
- A2A agent cards (GET only; A2A POST invocation requires Bearer
  `A2A_API_TOKEN` at the edge — verified from the entrypoint in
  #1763, see [mcp-security.md](mcp-security.md) §4).
- Strategy pages (`public/strategies/`): already public via the asset
  layer. True privacy for them needs removing them from output or adding
  them to `run_worker_first` plus a guard — a worker variable alone
  cannot gate them as deployed.
- The McpApiExplorer catalog ships in the client bundle: hiding its tab
  is not secrecy (see [mcp-security.md](mcp-security.md)).

If any of these ever carries sensitive content, the fix is to move it
behind a gate — not to assume nobody noticed it is public.

## 6. A2A token names: inbound vs outbound (Qunsultant/cfagent#2053)

This section is the ONE canonical place for the two A2A directions and
their token names. The naming muddle recorded as out-of-scope in the
#1754 gate-coverage inventory (`gate-coverage-inventory-1754.md` §9.4)
is resolved here; no other doc restates these names as authority, so
this section cannot drift against a second copy.

There are exactly two directions, and their names are never aliased to
each other in code. Reasoning from one name about the other direction
is always wrong.

| Direction | Worker secret name | Read by | Enablement |
| --- | --- | --- | --- |
| Inbound: cfagent as A2A server (`POST /a2a/*`) | `A2A_API_TOKEN` | `src/a2a/index.ts` via `src/a2a/meshCredentials.ts` (per-surface `A2A_TOKEN_<SURFACE>` first, shared token transitionally) | Deliberately disabled by absence: unset means dispatch fails closed (503, "A2A dispatch is not configured"); a missing/wrong token is 401. Enabling inbound dispatch is a separate owner decision to set `A2A_API_TOKEN` — deploy never writes it, and no outbound name enables it. |
| Outbound: cfagent as A2A client to cfpay | `CFPAY_OUTBOUND_TOKEN` (current) | `src/services/cfpayA2A.ts` `getCfpayConfig` | Live via its own name. Written by `.github/workflows/deploy.yml` from the GitHub-secret source (see the layer note below). |
| Outbound, transitional fallback | `DASHBOARD_API_KEY_IS_A2A_TOKEN` (deprecated, superseded by `CFPAY_OUTBOUND_TOKEN`) | `getCfpayConfig`, read only after `CFPAY_OUTBOUND_TOKEN` | Still written by deploy.yml alongside the new name during transition, so renaming cannot break live outbound dispatch across the deploy boundary. Retired only by a later owner-directed removal once the new secret is proven live — never silently, and never by deleting the fallback from code while deploy still writes it. |
| Outbound, pre-existing fallback | `CFPAY_A2A_TOKEN` | `getCfpayConfig`, read only after both names above | Unchanged by #2053. |

Rules:

- **Never alias.** Do not map `A2A_API_TOKEN` to an outbound name or
  an outbound name to `A2A_API_TOKEN` in code: aliasing would silently
  enable inbound dispatch, which is a separate owner decision.
- **Layer note (GitHub secret vs Worker secret).** Deploy writes
  Worker secrets; the code reads Worker secret names. In #2053 the
  GitHub secret feeding deploy (`S_DASHBOARD_API_KEY`) keeps its
  existing name — renaming that GitHub secret is an owner action, not
  part of this slice — while the Worker secret it writes is renamed to
  `CFPAY_OUTBOUND_TOKEN`. Do not confuse the two layers when reading
  deploy.yml.
- **Live inbound state is owner-visible only.** Code and config show
  no deploy path that sets `A2A_API_TOKEN`, but whether it is set
  out-of-band on the Worker cannot be proven from the repo and is
  never claimed here; that check belongs to the owner.
- **No secret value is ever recorded here.** Names, directions, and
  enablement states only.

## 7. Slack credentials: what is wired, and what is deliberately not (#3952)

Four Slack Worker secrets reach the deployment through
`.github/workflows/deploy.yml`, all as `optional_secret` pushes — an absent
value is reported in the job summary and leaves the channel in its
fail-closed state, never a deploy failure.

| Worker secret | Read by | Absence means |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | `src/security/webhookSecurity.ts` (`gateSlackRequest`), `src/agents/slackAgent.ts` | The inbound channel refuses every request (`/slack/*`); no signature check can pass. |
| `SLACK_BOT_TOKEN` | `src/services/slackFiles.ts`, `src/services/browserAgent.ts`, `src/services/screenerSlackDelivery.ts`, `src/trading/slack/agent.ts`, delivery jobs | The outbound bot-API leg is skipped; delivery surfaces report "no Slack transport configured" by name. The snap's bot leg also needs a channel passed per call — it has no `SLACK_CHANNEL` fallback. |
| `SLACK_CLIENT_ID` | `src/server/routes/messaging.ts` (`/slack/install`) | The install route answers 500 naming the missing variable. |
| `SLACK_CLIENT_SECRET` | `src/server/routes/messaging.ts` (`/slack/oauth_callback`) | The OAuth callback cannot exchange the code; installation fails at that step. |

**Deliberately not synced** (setting them on the Worker would configure
nothing the code reads):

- `SLACK_APP_TOKEN` — Slack Socket Mode only. This Worker serves Slack
  over HTTP events and the interactions endpoint, so an app-level token
  has no consumer here.
- `SLACK_VERIFICATION_TOKEN` — deprecated by Slack and superseded by
  request signing. Accepting it as a second verification path would
  weaken `gateSlackRequest`, not extend it.
- `SLACK_APP_ID` — no code path reads it; the install URL is built from
  the client id (`ETradeSlackTradingService.getInstallUrl`).

Wiring any of the three is a code change first (the reader), then a
deploy.yml line — never a deployment setting that silently implies a
capability.
