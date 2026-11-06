# Data operations docs

`docs/operations/data/` is the home for the data platform's operations
documentation: how market data is acquired, published, and made
searchable; how the knowledge corpus is kept honest; and how the
platform's broker/provider neutrality is enforced. These docs describe
what runs and how an operator verifies it. Architecture decisions live
in ADRs (linked, never restated here); the consolidated data
architecture assessment is
[assessment-01](../../architecture/data/assessment/assessment-01.md).

The data platform is the platform's data-and-knowledge layer
(DAMA-DMBOK framing): one plugin DataProvider contract with
capability routing across providers, capture of everything fetched
(raw + normalized, run-linked), a publish stage that moves stored
documents to R2 and the search indexes under one contract, and a
curated knowledge corpus whose contents are hash-verified against a
seed manifest. It is measured on freshness, completeness,
reconciliation accuracy, provenance coverage, and retrieval
correctness.

## Doc map

| Doc | What it covers | Status |
| --- | --- | --- |
| [data-provider-platform.md](data-provider-platform.md) | The #1116 provider platform as built: port + registry, capability routing/composition, capture, provider health, conformance | As-built |
| [feed-jobs.md](feed-jobs.md) | #3530 design: standalone per-source feed jobs, persisted local copies, scheduling, status surface, Copilot binding | Design — build in progress |
| [publish-stage.md](publish-stage.md) | #3527 design: publish as its own workflow stage (`publishDocument`), the coupled state it replaces, and the run-record decision | Design — build in progress |
| [knowledge-corpus.md](knowledge-corpus.md) | The #1169 knowledge corpus and AI Search serving: seed manifest, content-addressed storage, integrity, indexing, per-login discipline, endpoint retirement | As-built + in-flight |
| [neutrality-census.md](neutrality-census.md) | #3525: the broker/provider neutrality census — disposition model, counts, slice plan, shrink-only pin design | Survey record |

## Governing ADRs

These docs operate under, and never restate, the accepted ADRs:

- [ADR 0002](../../architecture/adr/0002-data-foundation-layer.md) —
  data foundation layer: port-first, Drizzle ORM, D1 as one adapter.
- [ADR 0020](../../architecture/adr/0020-do-d1-r2-topology.md) —
  DO vs D1 vs R2: actor runtime, queryable projection, blob storage.
- [ADR 0022](../../architecture/adr/0022-data-foundation.md) — data
  foundation repo-wide: one data-access layer behind ports, AOP
  transactions, dialect portability, intelligence substrate.

Related operations docs: [system runbooks](../runbook/README.md),
including the stuck-runs runbook that covers async job intervention.

## Changelog

- 2026-11-06 — Doc set created: provider platform (as-built), feed
  jobs and publish stage (designs, builds in progress), knowledge
  corpus (as-built + in-flight), neutrality census (survey record).
  Traces to #1116, #1169, #3525, #3527, #3530.
