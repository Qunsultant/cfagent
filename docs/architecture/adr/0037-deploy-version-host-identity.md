# 0037. Deploy-time host version: the async-job host identity is the deployed git SHA

- Status: accepted
- Date: 2026-11-23
- Deciders: owner (Mubasher)
- Issue: #6216 (follow-up to #6167, sub-issue of #4002)
- Implementing PR: (this PR)

## Context

The #6167 fix (PR #6177, merged 2026-11-22) stamps a host version
onto `mas_async_jobs.host_version` at claim time and, at reap time,
compares the claim-time version with the reap-time version to name
the restart class (deploy vs same-version) and to gate a stillborn
re-arm: a stillborn orphan (died within 10s of its claim, before its
first heartbeat) on an unchanged version is not re-armed, because an
identical re-arm replays the identical dispatch and dies identically.

Live verification of #6167 FAILED on 2026-11-23 04:03 EST. A feed
job (job `2bf118b3`) was orphaned and reaped by the 15-minute
stale-job sweep, but the reap named no restart class ("host
unknown") and the stillborn orphan (died 0.21s after its claim) was
re-armed. The root cause, verified in code on main `52167f898`: the version source is `CF_VERSION_METADATA.id`
(`hostVersionFromEnv`, `src/agents/orchestrator/asyncJobs.ts`), and
that binding is NOT available in the OrchestratorAgent Durable
Object execution context where jobs are claimed and reaped. Both
sides read null, so `host_version` is always NULL in production,
`restartClassFor` always returns "unknown", and the gate — which
refused only on "same-version" + stillborn — could never refuse.
The stillborn gate was inert in production.

The #6167 gate also preserved the old behaviour on "unknown"
("never refuse a re-arm on evidence we do not have"). The live
record shows that default let the re-arm loop through: three feed
re-arms on 2026-11-22 plus the 2026-11-23 one, all dead in seconds.
The version was unknown because the source was unavailable in the
DO, not because a deploy happened.

## Decision

### The host version is the deploy-time git SHA, injected by the deploy workflow

One host-identity source, shared by claim and reap
(`hostVersionFromEnv`, `src/agents/orchestrator/asyncJobs.ts`):

1. **Primary: `CF_DEPLOY_VERSION`** — the git SHA of the deployed
   commit, injected by the deploy workflow into `wrangler.jsonc`
   vars (a `sed` step in `.github/workflows/deploy.yml`, the same
   pattern as the KV ID step) before `wrangler deploy`. A plain var
   IS visible in the Durable Object env, where `CF_VERSION_METADATA`
   is not. The value must be a full 40-hex git SHA: a non-SHA value
   (the wrangler.jsonc placeholder `<DEPLOY_VERSION>`, a failed
   injection) is rejected, never a version — a constant placeholder
   would stamp the same fake version on every claim and misread
   every reap as "same-version", including after a real deploy. A
   failed injection reads as unknown, not as a fake version, and
   the deploy step fails closed (exit 1) when the SHA cannot be
   resolved or the stamp does not land: a deploy without a version
   is a broken deploy.
2. **Fallback: `CF_VERSION_METADATA.id`** — kept for contexts where
   the deploy var was never injected (a local/dev deploy). It is
   the fallback, not the primary, because it is only available in
   the Worker entrypoint: preferring it would make a Worker-side
   claim and a DO-side reap compare different formats and read
   "deploy" on every reap. The deploy var is preferred BECAUSE it
   is the only source available in both contexts, so a claim and a
   reap always agree when it is set.
3. **Otherwise null** — legacy rows, and deployments that report no
   version, stay null (unknown). Nothing is invented.

The SHA changes on every deploy and is stable within a deploy, so
the restart classes keep their #6167 meaning: a changed version is
a deploy restart, an unchanged version is a same-version restart
(eviction / hibernation / crash, not a deploy).

### A stillborn orphan is re-armed ONLY on positive evidence of a deploy

The gate (`shouldRearmOrphanedRow`, shared by the onStart recovery
and the 15-minute sweep) now refuses a re-arm whenever the orphan
is stillborn and the restart class is NOT "deploy" — same-version
OR unknown. The #6167 "never refuse on evidence we do not have"
default for unknown is retired: when the orphan died on arrival
and no deploy is evidenced, the dispatch is the likely cause, so
it is failed visibly with the reason named instead of re-armed.
The refusal reason is named in the reap record (`notRearmedReason`,
carried in the `async_job.failed` audit and the orphan message).
A progressed orphan is still re-armed on any class (it died
mid-work, so a resume may land), and a stillborn orphan on a
changed version is still re-armed (a deploy killed it — the
#3907/#4002 case).

The stillborn window itself is now symmetric: `isStillbornOrphan`
requires the last activity within 10s of the claim on EITHER side.
The old one-sided check (`diff <= bound`) misread a last activity
well BEFORE the claim as stillborn, and the #4002 recovery seeds
carry exactly that shape (last-activity stamps minutes before
their start stamps) — the #6216 gate would have refused their
re-arms. A millisecond either side is the #6167 clock-skew
tolerance; minutes before the claim is a temporally inconsistent
row, not a dispatch that died on arrival. The #4424 shard-chain
seed is updated for the same reason (both stamps equal read as
stillborn; the stale shard now progresses 5 minutes before dying,
which is what that test pins).

### Alternatives considered

- **Durable Object identity as the host identity** (the DO's own id
  / a stable instance marker): rejected. The DO id is stable across
  restarts — the same DO instance is re-created on the same id after
  an eviction — so it cannot distinguish a deploy restart from a
  same-version eviction. It tells the reap nothing about whether
  the host changed. (The claim and the reap also run in the SAME
  DO, so the id would be identical on both sides by construction.)
- **`CF_VERSION_METADATA.id` only** (the #6167 source): rejected.
  It is unavailable in the DO execution context — the verified
  root cause. Keeping it as the only source leaves the gate inert.
- **A Worker secret for the version** (set by the sync-secrets
  job): rejected. The sync-secrets job runs AFTER the deploy job,
  so the code would deploy first with the old version value and
  the secret would update later — the first claims after a deploy
  would carry the stale version. The wrangler.jsonc stamp sets the
  var atomically with the code.

## Consequences

- A job claimed and orphaned in production carries a non-null
  `host_version` (the deployed SHA) in `mas_async_jobs`, and the
  reap names the restart class from a real comparison.
- A stillborn orphan on an unknown version is no longer re-armed.
  This is a deliberate behaviour change from #6167: the unknown
  fallback no longer preserves the old re-arm. The risk is a
  stillborn orphan that WAS killed by a deploy but whose claim
  predates this fix (legacy row, null version) being refused
  instead of re-armed — a legacy-row edge case, bounded by the
  rows claimed before this deploy, and the refusal is visible
  (named reason) rather than a silent loop.
- A local `wrangler deploy` without the workflow's stamp leaves
  the literal placeholder in the var; the resolver rejects it, so
  local deploys behave as pre-#6216 (unknown version, stillborn
  re-arms refused on unknown). No fake version is ever stamped.
- The deploy workflow gains a hard-failing step: a deploy whose
  SHA cannot be resolved, or whose stamp does not land, fails the
  deploy job. This is intentional — a deploy without a version
  silently reverts the stillborn gate to inert.
- The `Env` interface gains `CF_DEPLOY_VERSION?: string`
  (`src/types.ts`); the wrangler.jsonc `vars` section gains the
  placeholder. No new store, no new endpoint, no schema change —
  `host_version` is the #6167 probed additive column, unchanged.
- Live verification (owner step, after merge + deploy): trigger a
  feed job, observe an orphan, confirm the reap names the class and
  a stillborn orphan is not re-armed.
