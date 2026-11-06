# Performance Analysis — Measurement Plan (recovered from PR #1828)

> **Recovered report — written in PR #1828 (2026-10-26), recovered in #3461 (2026-11-06).**
>
> This document replaces the draft that PR #1828 carried. That draft stated latency figures
> ("< 15 ms Worker cold start", "sub-5 ms Durable Object memory reads", "< 2 ms SQLite reads/writes")
> as if they had been measured on this platform. They were not: they are generic Cloudflare
> characteristics, not observations of `cfagent`. Publishing them under an "analysis" heading would put
> numbers in the repository that no test, trace or benchmark supports — the exact class of claim the
> governance programme exists to stop.
>
> **Authority rule:** where this document and the code disagree, the code and its tests are current.
> This is a plan, not a result. Nothing here is a measured value.

## What this platform can and cannot observe today

| Measurement | Observable now? | Where the evidence would come from |
|---|---|---|
| Worker request CPU time | No | `wrangler tail` / Cloudflare analytics; not currently captured per route |
| Durable Object storage read latency | No | DO analytics; the code has no timing instrumentation on storage calls |
| Durable Object request count per UTC day | Yes, at the budget line | Free-plan ceilings are enforced and alerted (70% alert); see `docs/compliance/platform-limitations-risks-gaps-issues-constraints.md` |
| Workflow step duration | Partly | Workflow runs record step outcomes; duration is not aggregated into a report |
| LLM latency per turn | Partly | Provider responses carry timing in some paths; no neutral aggregation |
| Screen run wall time | Partly | Run records carry start/end; no percentile report |
| Frontend bundle size | Yes | `vite build` output; a budget check exists in the build gate |

## What to measure, and how to make it trustworthy

1. **Instrument before quoting.** Any latency claim must come from a recorded measurement with the
   environment, sample size and date attached. A figure without those three is a guess and does not
   belong in `docs/`.
2. **Prefer the budgets that are already enforced.** The free-tier ceilings (5M DO rows read, 100k
   writes, 100k DO requests per UTC day; 3 cron triggers; 50 subrequests per isolate) are enforced by
   configuration and alerts. They are facts about this deployment; vendor latency curves are not.
3. **Measure the surfaces users wait on**, in this order: chat turn end-to-end, screen run start →
   first shard result, options chain read, portfolio read. These map to routes that already exist.
4. **State regressions as comparisons, not absolutes.** "p95 rose from X to Y between commits A and B on
   the same runner" is checkable; "sub-5 ms" is not.

## Known performance-shaped constraints (documented facts, not measurements)

These are already recorded in the constraints catalogue and are the platform's real performance
boundaries today:

- Durable Object and D1 free-tier daily budgets are the binding limit; exhaustion took sign-in down on
  2026-10-26 with an alert at 70%.
- The static-asset path bypasses the Worker through the `ASSETS` binding, so static traffic does not
  consume Worker CPU.
- `WorkflowPort` is a linear pipeline with at most 4 parallel shards and 3 retries per step (ADR 0017) —
  throughput is shaped by that, not by an unmeasured cold-start figure.
- `MAS_MAX_STEPS=4` bounds the agent tool loop, which bounds worst-case turn latency by construction.

## Why this document is a plan and not the recovered draft

The draft's structure (runtime, storage, streaming, LLM, bundle, scalability) is sound and is kept here
as the measurement agenda. What was removed is the numbers. If someone measures them — with the method
above — this file is where the results belong, dated and attributed.
