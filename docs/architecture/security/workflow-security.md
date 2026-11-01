# Workflow security — unattended work

How work that runs without a user in the room is authenticated,
authorized, and guarded. User-driven work is in [authn.md](authn.md) and
[authz.md](authz.md); the background identity exception is tracked in
#1066 and documented in [etrade.md](etrade.md) §7.

## 1. Unattended work has an identity problem

Cron ticks, queue jobs, and renewal passes have no session. Today they
run as the synthetic `default_trader` identity, hardcoded in the worker
`scheduled()` and `queue()` handlers. That identity is the consumer of
the process-wide static E*TRADE token pair (see [etrade.md](etrade.md)
§7): background jobs stand or fall with one env-bound credential, and
their actions are attributed to a made-up name.

The #1066 plan replaces it with an explicit, non-secret **service
identity** whose token is obtained through the normal 3-legged flow and
stored like any user's — same expiry, renewal, revocation, and audit.
Until that lands, every claim in this doc about background work carries
the `default_trader` caveat, and no background path should be described
as "the user's" work.

## 2. What runs unattended

| Work | Trigger | Guard (fire/no-fire decided inside) |
| --- | --- | --- |
| ScheduledAgent tick (due goals, budget checks, Orchestrator jobs) | `*/30 * * * *` | Inside the tick route |
| Daily options-research run | Rides the 30-min tick (Workers Free ceiling: 5 cron triggers/account) | Weekday, ≥ 21:00 UTC, not already fired today (durable guard in `mas_settings`) |
| Weekly reflection job (#705) | Rides the 30-min tick | Sunday, not already fired this week |
| Weekly strategy-weight adjustment (#754) | Rides the 30-min tick | ISO-week guard + adaptation kill switch in `mas_settings` |
| E*TRADE token renewal | `0 3 * * *` | Iterates every stored token; renews unexpired ones |
| Nightly message retention (#255) | `0 4 * * *` | Retention window enforcement + one `mas_events` row per run |
| Options-analysis queue jobs | Queue messages | Ack on success, retry on failure; per-message `taskType` dispatch |
| Hourly Market Screen | Screener schedule | Durable per-minute execution claim (`screening:scheduled:last-slot:…`) suppresses duplicate delivery |

Guards are durable (stored state), not in-memory: a redeploy or a
duplicate delivery must not double-fire a job. "Skips are cheap and
explicit" is the design rule — a tick that decides not to fire still
records the decision.

## 3. The kill switch is a security control

The adaptation kill switch (#754, in `mas_settings`) can stop the
strategy-weight adjustment loop. It is not a feature flag: it is the
mechanism by which bounded adaptation stays bounded. Any workflow that
changes weights, budgets, or trading posture without consulting a kill
switch is outside the governed path, and the CISO clarification on
"kill switch as a measurable objective" (#907) is the reason this is
stated as a control rather than an option.

## 4. Routing and attribution for background calls

Background dispatches go to Durable Objects with an `x-user-login`
header set to the background identity — the same header user-driven
forwards carry. Since #1764 they additionally carry
`x-actor-kind: background` (see
`src/security/backgroundAttribution.ts`), so a reader of headers or
audit records can tell background work from user work without
knowing the configured service login value. Authority is never the
header alone: `resolveActorAttribution()` returns "background"
only when the login equals the configured service login (the
serviceDispatch rule — with no configuration, nothing is a service
dispatch), and a `background` header on any other login resolves
to "user" with an anomaly flag, so a client-spoofed header cannot
claim background work. The service identity itself is a real login
authorized through the normal flow (see [service-identity.md](service-identity.md));
the header only names the actor kind for audit and logs.

Queue handling, pinned by #1764 (F-32 closed for the screener
queues; the legacy `default_trader` removal itself remains #1066,
out of this slice's scope):

- A retryable handler failure is bounded, not infinite: the
  platform re-delivers up to `max_retries: 3` and then lands the
  message in the dead-letter queue (`screener-events-dlq` /
  `screener-events-delivery-dlq`, pinned against `wrangler.jsonc`
  by #2544). A message that can never decode is acked + recorded,
  never retried — redelivering undecodable bytes would
  poison-loop the batch.
- A terminal drop — a dispatch denied by the identity rules, an
  undecodable message, or an envelope no handler exists for — is
  acked (dropped, never retried: a re-dispatch would deny or loop
  again) AND leaves a structured dead-letter record
  (`src/messaging/deadLetter.ts`): one parseable
  `[dead-letter] {json}` line per drop carrying queue, reason,
  message/run/unit ids, and actor when known. The record is the
  auditable half of the drop; ack/retry semantics are unchanged.
- The DLQ queues intentionally have no consumer in this slice: a
  DLQ consumer that acked would destroy the evidence it inspects.
  A DLQ landing is platform-recorded (queue metrics + retention),
  and a DLQ inspection/replay consumer is the named follow-up,
  not silently built here — until it lands, the terminal-drop
  records above are the auditable dead-letter trail, and DLQ
  depth is monitored via the Cloudflare dashboard.

## 5. Rules for adding unattended work

1. Name its identity explicitly. "Runs as the system" is not a name.
2. Give it a durable fire/no-fire guard. A cron schedule is not a guard.
3. Give it a kill switch if it changes anything consequential
   (weights, budgets, trades, memberships).
4. Make its audit events attributable to its identity, distinguishable
   from any real user.
5. Never let it fall back to a user identity silently. If it needs a
   user's authority, that authority is delegated explicitly (see
   [authz.md](authz.md) §5) or the job fails loud.
