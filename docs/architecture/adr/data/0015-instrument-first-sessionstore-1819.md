# ADR 0015: Instrument first for SessionStore resource usage (#1819)

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner, #CISO-bhdm
- Issue: #1819 (consolidation: #1884)
- Implementing PR: #1890 (main commit, when merged)
- Related: docs/architecture/security/sessionstore-resource-measurement-1819.md,
  docs/architecture/security/sessionstore-resource-process-1819.md

## Context

On 2026-10-26 sign-in bounced because the SessionStore Durable Object
hit the free-tier rows-read quota (5M rows read/day) on `POST /kv`
(Worker script `ai-search-agent`). Login start itself worked; the
failure was downstream at callback/session landing. The owner
direction on 2026-10-27 was "you own this" for #1819, followed by
"instrument first": build the instrumentation now, in the aligned
shape, and the owner will then supply Cloudflare dashboard data for
comparison against instrumented numbers.

The measurement slice verified the CEO lane's claims against current
main and produced a code-side caller inventory with numbers. Its
headline findings: the top SessionStore source is wired `requireAuth`
(about 1 read per authenticated `/api/*` request); polling alone does
not explain 5M; and the 5M-level burner — SessionStore-local versus
account-summed — remained explicitly unmeasured pending instrumented
totals versus dashboard per-namespace curves. The `sessionStore.ts`
"no daily read cap" comment was proven false on the free tier.

## Decision

For #1819, measurement and instrumentation come before any fix, any
production switch change, and any paid-plan decision:

1. Emit per-op resource events (namespace, op, rows read/written,
   caller, trigger, statement fingerprint only — never bindings,
   tokens, or user data) in the aligned shape (see ADR 0018), so the
   output is comparable with dashboard data: same rows-read/written
   units, caller + trigger attribution, time-bucketed totals.
2. Compare instrumented totals against the owner-supplied dashboard
   SessionStore-namespace hourly series, same buckets, same units,
   before naming a burner.
3. Scope the fix to the burner the comparison names. Never guess it
   in advance. A quota reset alone is not verification: #1819's
   acceptance requires sign-in verified working after the fix or
   decision, not just a fresh day's budget.

## Consequences

- The fix is deliberately delayed until the comparison names a
  burner. That delay is the decision, not a gap: an unmeasured fix
  risks fixing the wrong caller while the real burner keeps running.
- Instrumentation output must stay dashboard-comparable; any change
  to units, attribution, or bucketing breaks the comparison the whole
  sequence depends on.
- Projection totals are a SessionStore-only lower bound on
  account-wide usage. A cap-alert breach implies the account is at
  or above 70%; no breach does not prove account safety. That
  honesty is carried in every report, not footnoted away.
- #1819 stays open until its acceptance is met; the rollup slice's
  report comment was explicitly not a §15 PASS.

## Alternatives considered

- **Fix the guessed burner first (e.g. throttle polling).** Rejected:
  polling alone does not explain 5M, so the fix would most likely
  miss the burner and the incident would recur on the next quota day.
- **Move to a paid plan first.** Rejected: spend without a named
  burner buys headroom, not a diagnosis, and hides the caller that
  would eventually exhaust the higher cap too.
- **Dashboard data only, no in-Worker instrumentation.** Rejected:
  dashboard curves show totals per namespace, not which caller or
  trigger produced them; without caller attribution there is
  nothing to scope a fix to.
- **Instrument and fix in the same slice.** Rejected: the fix cannot
  be scoped until the comparison exists, so bundling them would
  either guess the fix or stall the instrumentation behind it.
