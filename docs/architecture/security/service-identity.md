# `SERVICE_USER_LOGIN` — the service identity for unattended work

> Operator runbook for the service-identity configuration introduced by
> #1185 (design #1066). Companion to [etrade.md](etrade.md) §8, "Life after
> `default_trader`".

## What it is

`SERVICE_USER_LOGIN` names the system's own identity for work that runs
**without a user session**: cron and queue dispatches, the payments-ledger
and inbound-email forwards, the wallet scanner, and unattended
TradingAgent / screener / report paths.

It replaces the legacy `default_trader` fallback, under which those paths
silently borrowed a synthetic shared login. The service identity is a
**real login**: it authorizes E*TRADE once through the standard Connect
E*TRADE (3-legged OAuth) flow, and its token is stored per-identity in the
SessionStore as `etrade:token:<ENV>:<login>` — the same store, expiry,
renewal, and revocation as any user's token.

The configured value is an **identifier, not a credential**. It grants
nothing by itself; the stored OAuth token does the work, and revoking that
token disables unattended work without touching any user flow.

## Resolution

There is exactly one resolution point:
`resolveEnvironmentConfig` → `getServiceUserLogin(env)`
(`src/security/serviceIdentity.ts`).

- The value must be login-shaped: `/^[A-Za-z0-9._-]{1,80}$/`.
- Unset, blank, or malformed resolves to **no service identity** (`null`).
- There is no fallback and no default. Consumers fail closed (below).

## How to set it

Set it as a **plain (non-secret) environment variable**, in the target
environment's deployment configuration — in this repo's plumbing, the
`wrangler.jsonc` `vars` block for the target environment (the route the
other plain config values such as `IAAA_PDP_ENABLED` use), so every deploy
carries it. It is configuration, not a credential: do **not** route it
through the Worker secrets sync, and do not store it in the secrets store.

Order of operations:

1. Choose the service login (an existing operator identity or a dedicated
   one) and set `SERVICE_USER_LOGIN` to it.
2. Authorize that identity once via the Connect E*TRADE flow, so a stored
   token exists under its login.
3. **Then** deploy / merge Phase A of #1185 (PR #1232). Merges deploy to
   PROD; from that deploy onward, unattended work runs under this identity.

Setting it after Phase A has deployed is also safe: dispatches that were
skipped simply resume on the next tick once the value is present and the
identity's stored token exists. No data migration is needed in either
order (see "Addressing" below).

## Provisioning completeness checklist (#1764, F-33)

Provisioning is an owner step, not code, so no code change can
complete it — but it must not be silent either. The status route
(`GET /api/admin/service-user/status`, platform-admin caller)
reports a `provisioning` object alongside the pre-existing status
fields:

- `service_login_configured` — `SERVICE_USER_LOGIN` is set and
  login-shaped.
- `platform_membership_live` — a live, unrevoked, unexpired
  platform-scope member binding exists for the service identity
  (an expired binding does not count).
- `brokerage_token_present` — a stored token exists for the
  service identity (presence only; the token value is never
  exposed, and a failed store read reports `unknown`, never a
  guessed pass or fail).

`provisioning.complete` is true only when every item passes.
Every non-pass item names its owner action in
`provisioning.ownerActions`: provision the platform tier via
`POST /api/admin/service-user/provision {"tier": "platform"}`,
authorize the service login once via the Connect E*TRADE flow,
or re-check token presence after a store-read failure. An item
that is not a pass is therefore explicitly carried with an
owner action, which is the #1764 acceptance for this checklist
— the checklist is complete, or its remainder is owned, never
unrecorded.

## Implications if it is not set

Fail-closed, by surface (behaviour verified against the #1185 Phase A/C
tree):

| Surface | If `SERVICE_USER_LOGIN` is unset |
|---|---|
| Worker `scheduled()` — research tick (#354), reflection (#705), adaptation weights (#754), retention dispatches | **Skipped**, with a console error naming the missing config. Nothing is dispatched under a fabricated identity. |
| Worker `queue()` — `options_analysis` messages | Dispatched under the message payload's stored owner when it carries one. With **neither** a payload owner nor a service identity, the message is **refused and retried** (existing retry path) rather than dispatched. |
| Payments ledger forward (`src/payments/ledger.ts`) | **Throws** — "payment ledger unavailable: no service identity configured". Ledger reads/writes through the Orchestrator forward are unavailable. |
| Inbound email agent forward (`src/trading/email/agent.ts`) | Fails closed — the forward asserts the service identity and will not run under a synthetic login. |
| Wallet scanner → Orchestrator (`src/services/cloudflareWalletsScanner.ts`, #700) | Forwards **asserting no identity** (affinity headers only). Nothing is attributed to a synthetic login; identity-scoped downstream work declines. |
| TradingAgent unattended calls (`src/agents/trading-agent.ts`) | The bare instance name maps only to the configured service identity; without one, unattended calls **refuse** instead of acting as a shared trader. |
| Screener / report-asset naming (`src/agents/screenerAgentName.ts`, `src/services/scheduledTasks.ts`, `src/events/screenerPublishers.ts`) | The bare `"default"` / `"trading"` instance names belong to the service identity only. Without one, unattended screener/report work stays owner-scoped or is skipped — it never lands on the shared instances under a fabricated login. |

**Not affected** when it is unset:

- Every user-facing flow — routes resolve the caller's login from the
  authenticated session (`x-user-login` from `session.githubLogin`), never
  from this config.
- The 03:00 UTC E*TRADE token-renewal pass — it asserts no identity (it
  enumerates every stored token) and runs either way.
- The ScheduledAgent tick itself (`onCron`) — it evaluates due goals and
  budget checks independently of the Orchestrator dispatches above.

## Addressing is not identity

`SHARED_ORCHESTRATOR_INSTANCE` in `src/security/serviceIdentity.ts` keeps
the legacy string as a Durable Object **address** only — it selects which
Orchestrator instance unattended work talks to. It is never used as a
login, token key, audit identity, or payer. Separately, the service
identity inherits the bare instance names (`"default"`, `"trading"`), so
the Durable Object state accumulated under the legacy identity remains
reachable under the service identity: **no data migration is required**,
and records created by unattended work are keyed under the service login
like any owner's records.

## Changing or revoking it

- **Change the value:** set the new login and make sure that identity's
  stored E*TRADE token exists *first* (authorize it via the linking flow).
  Dispatches use the new identity from the next tick; the previous
  identity's records stay keyed under its own login.
- **Revoke unattended access:** revoke/delete the service identity's
  stored token. Unattended E*TRADE work stops; user flows are untouched.
- **Roll back a deploy:** redeploy the previous release. Re-adding the old
  `ETRADE_OAUTH_TOKEN*` secrets restores nothing — since #1185 Phase B,
  no code reads them.
