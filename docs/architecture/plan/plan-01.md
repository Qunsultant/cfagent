# Architectural Implementation Plan — Plan-01

**Status:** Approved Implementation Roadmap
**Document ID:** `docs/architecture/plan/plan-01.md`
**Authority:** Cloudflare Agent Platform Engineering Lead & Architecture Board
**Baseline Commit:** `e6d80a0` (main)

---

## 1. Executive Summary & Plan Scope

This document details the phased engineering execution plan for operationalizing the target architecture (`strategy-01.md` & `blueprint-01.md`). The plan structures work across four core engineering workstreams:
1. **Agent Substrate & Coordination Workstream**
2. **Data Layer & Session Persistence Workstream**
3. **IAAA Security, Identity, & Governance Workstream**
4. **Independent Evaluation, Observability, & Quality Workstream**

---

## 2. Workstream Breakdown & Phase Schedules

```
+-----------------------------------------------------------------------------------+
| Phase 1: Re-Baseline & Foundation Hardening (Complete)                             |
| - Conformance audits, model lock (#540), research fallback (#543)                 |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| Phase 2: Durable Delegation & Task Ledgers (In Progress / Active Baseline)        |
| - ResearchTaskLedger (#577), state transition validation, execution path logging  |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| Phase 3: Universal Sub-Agent Ledger Rollout & Evaluator Infrastructure            |
| - Screener & NLQ ledgers, isolated Judge evaluator, stale task reaping            |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| Phase 4: Production Multi-Tenant Scale & Async Workflows                          |
| - Cloudflare Workflows integration, D1 global telemetry, automated canary deploys |
+-----------------------------------------------------------------------------------+
```

---

## 3. Milestone Deliverables & Technical Acceptance Criteria

### Milestone 1: Universal Task Ledger Substrate (Phase 3 Target)

* **Objective:** Expand the `ResearchTaskLedger` pattern to `ScreenerAgent` and `NLQ` query processing.
* **Deliverables:**
  * Implement `screener_task_store` and `nlq_task_store` tables in respective Durable Objects.
  * Standardize status lifecycle across all DOs: `queued` -> `claimed` -> `running` -> `completed` / `failed` / `escalated`.
  * Add automatic heartbeat updates and stale-task operator surfacing.
* **Verification Gate:** Unit and integration test suites proving deterministic check-and-set idempotency and transition logs.

### Milestone 2: Independent Evaluator Network (Phase 3 Target)

* **Objective:** Decouple output judgment from generator agents.
* **Deliverables:**
  * Create `EvaluatorAgent` / `Judge` RPC contract for scoring research reports and screening outputs.
  * Implement deterministic criteria validators (data quote checking, price freshness verification, boundary rule checks).
  * Persist evaluation verdicts directly onto task ledger records.
* **Verification Gate:** Automated tests verifying that flawed or non-conforming research reports receive `failed` or `rejected` verdicts before reaching user interfaces.

### Milestone 3: IAAA Identity & Key Governance Hardening (Phase 4 Target)

* **Objective:** Complete full conformance with IAAA-945 specification.
* **Deliverables:**
  * Enforce cryptographically derived stable identity headers (`usr_<hash>`) across all edge routes.
  * Implement automated session token rotation for E*TRADE OAuth in `SessionStore`.
  * Operationalize break-glass administrative procedures and audit key validation.
* **Verification Gate:** Zero-trust security suite passing `tests/security/` and automated PR policy gate compliance.

---

## 4. Resource Allocation & Risk Management Matrix

| Risk Factor | Severity | Impact | Mitigation Plan |
|---|---|---|---|
| **Hot-Path Ledger Latency** | Medium | Increased turn-around time for chat queries | Execute task ledger write operations asynchronously; warn and proceed on ledger write failure without blocking core research output. |
| **Durable Object Lock Contention** | High | Request queueing under high tenant load | Maintain single-tenant isolation boundaries per DO instance; restrict cross-tenant aggregations to background D1 pipelines. |
| **Model Non-Determinism in Screening** | High | Unreliable stock/option candidate outputs | Strict capability allocation: keep all screening rule evaluations inside pure TypeScript/WebAssembly service routines. |
| **E*TRADE OAuth Session Expiration** | Medium | Pipeline halt on scheduled background cron runs | SessionStore background keep-alive refresh loops with KV cache mirroring. |

---

## 5. Testing, Verification, & Quality Gates

Every implementation step governed by this plan must pass the standard system check pipeline:

1. **Design System & Type Check:** `npm run check` (runs design token validation, `tsc --noEmit`, Vitest CI tests, and Vite build).
2. **Policy Gate Verification:** Compliance with `.github/workflows/policy-gate.yml` (linked issue, `lane:*` label, agent hashtag, `CHANGELOG.md` entry).
3. **Pre-Merge Integrity Script:** Passing `./scripts/verify-before-merge.sh`.
4. **Page-Shell Conformance:** SPA pages render inside the `PageShell` standard (`docs/archive/design-system-01.md`); conformance is pinned by `tests/shell_conformance_1804.json` (25 of 26 after S4; `chat` deferred per ADR-0021).
