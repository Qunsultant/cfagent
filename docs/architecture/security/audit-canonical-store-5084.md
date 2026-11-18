# Audit — one store: the canonical-store decision (issue #5084, program #5080)

**Decision (2026-11-18, S5 slice): the canonical audit store is the IAAA audit
store** — the contract in `src/data/auditLogPorts.ts`, the pure model + single
write path `recordAuditEvent` in `src/security/iaaaAudit.ts`, the wiring
`createWiredAuditStore` in `src/security/iaaaAuditStore.ts`, backed by the
SessionStore Durable Object's `audit-append` op on `iaaa-audit:` keys.

**What S5 changed:** the audit-append client logic is single-sourced in the
AuditLog family's shared implementation (`src/data/auditLogStoreImpl.ts`'s
`createAuditLogStore`). The security layer's `createAtomicAuditStore` is now
a thin adapter over it. Both `AUDIT_PORTS_ENABLED` states serve the one
implementation; the flag selects the composition root only, not the
implementation. No file was deleted. No audit event was lost: both
compositions always wrote the same DO keys with byte-identical behavior
(pinned by the #2435 conformance suite).

## Evidence for the canonical store

- **E1 — every live write goes through it.** All live call sites write via
  `recordAuditEvent(createWiredAuditStore(env), ...)` — `src/server/routes/
  auth.ts`, `core.ts`, `otelArchive.ts`, `platform.ts`, `privacy.ts`,
  `src/agents/routes/dataLifecycle.ts`, the scheduled agent. No live caller
  writes to the data-layer family directly: `createAuditPorts` has exactly
  one caller, `createWiredAuditStore` itself.
- **E2 — every live read of IAAA audit events goes through it.** The IAAA
  Admin Overview Audit events view (`src/security/iaaaAdminOverview.ts`'
  `buildAdminOverview` → `deps.auditStore.list()`, wired with
  `createWiredAuditStore(env)`) and the logged-in-users login counts
  (`src/server/routes/auth.ts`, `createWiredAuditStore(env).list()` filtered
  to `auth.login`) both read the one store.
- **E3 — the production default serves the security layer.** The flag is
  OFF by default and deliberately NOT in `wrangler.jsonc`; production
  serves `createAtomicAuditStore` from `iaaaAuditStore.ts`. The data-layer
  implementation was reachable only via an unset flag.
- **E4 — no data divergence to reconcile.** Both implementations spoke the
  SAME DO op on the SAME keys with byte-identical behavior (pinned by
  `tests/step5d_audit_log_conformance_2435.test.ts` cross-composition
  rows). The duplication was client code, not data — no dual-write, no
  migration, no event at risk.
- **E5 — audit-before-allow lives here.** The failure policy
  (`classifyAuditFailure`, `shouldBlockAction`, `isAuditedSuccess`) and
  the hash chain + validation live in `src/security/iaaaAudit.ts`; the
  data layer carries no policy. A consequential action whose audit write
  fails BLOCKS; an action is an audited success only when authorization
  allowed it, it succeeded, and its audit record was written.
- **E6 — the single write path, by grep.** `grep -rn 'op: "audit-append"'
  src/` after S5: exactly one production client implementation
  (`src/data/auditLogStoreImpl.ts`); the DO-side handler of the same op
  (`src/security/sessionStore.ts`, the server end — not a second client);
  the in-memory op mirror (`src/data/inMemoryAuditLogAdapter.ts`, a test
  double of the DO op — not a production store); the fake DO
  (`tests/fake-session-store.ts`, test only). Pinned structurally by
  `tests/audit_one_store_5084.test.ts`.

## What is NOT a duplicate (recorded so the next reader does not re-open it)

- **The #1688 audit REPORT family (`src/data/auditReportPorts.ts` and
  friends) is a projection, not a second IAAA audit store.** It records
  DIFFERENT events — agent chain lifecycle events
  (synthesize/approve/kill/project/reconcile/seed) as `AuditEventRow`s in
  D1 (`agent_chain_audit`) plus canonical report rows (`agent_reports`)
  — for chain/report reads. The durable object remains the authoritative
  full copy. It stays as-is; S5 does not consolidate it into the IAAA
  store.
- **Naming collision (residual, not fixed here):** `auditReportPorts.ts`
  exports an `AuditStore` interface (reader + writer over
  `AuditEventRow`) that is a DIFFERENT type from the IAAA `AuditStore`
  (the `AuditLogPort` contract). Same name, different shape. A rename
  is a separate slice — the old name is load-bearing for the chain/report
  consumers, and renaming it touches many files. Recorded here; not
  silently fixed, not silently left.
- **The Audit Vault page (`?tab=audit-vault`) reads `mas_events`, not the
  IAAA audit store.** `src/client/AuditVaultPage.tsx` fetches
  `GET /api/audit?limit=30`, served by `src/agents/routes/audit.ts`,
  which reads the orchestrator's `mas_events` table (issue #270) — a
  third, older audit record for session-scoped agent events, written by
  the orchestrator's `recordAudit()`. S5 deliberately did NOT re-point
  the Vault: `mas_events` rows and IAAA audit events are different
  records, and re-pointing the read without migrating the writes would
  make the Vault go empty for orchestrator events — evidence loss, not
  consolidation. Whether the Vault should read the canonical store (and
  what happens to `mas_events` writes and history) needs its own
  decision, filed as [Out-of-Scope] issue #5264 under program #5080.
  The canonical audit surface S5 proves is the IAAA Admin Overview
  Audit events view, which reads the one store
  (`tests/audit_one_store_5084.test.ts`).

## The taxonomy, corrected in one place

The program body (#5080) says audit is "surfaced in the Audit Vault".
That is imprecise after this finding: IAAA audit events are surfaced in
the IAAA Admin Overview Audit events view; the Audit Vault page surfaces
the older `mas_events` record. The taxonomy's owner line stands —
`src/security/iaaaAudit.ts` + `iaaaAuditStore.ts` (`recordAuditEvent`,
audit-before-allow) — and the implementation now follows the contract
into the data layer where #2435 already put it. Ownership is the
capability, not the file: the security layer remains the owner (façade
+ policy + write path); the data layer holds the single client
implementation.

## Config

No new config. `AUDIT_PORTS_ENABLED` stays (flag selects the composition
root only now); absence = off; not in `wrangler.jsonc`. No new coded
messages — S5 adds none; the catalog lands with S7 (#5086).

#CISO-bhdm
