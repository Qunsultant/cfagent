# Comprehensive UX & Multi-Tier Architectural Anti-Drift Framework

**Document Version:** 2.0.0
**Date:** 2026-10-25  
**Status:** Approved Architecture & Security Anti-Drift Specification
**Target Application:** NextGenTP / AI Search Agent (`ai-search-agent`)  
**Scope:** Client UX, Edge Gateway, Agentic Orchestration, Data Tier, Infrastructure, and Security Architecture
**Consolidation (#3802, 2026-11-08):** this document is the single anti-drift home. The former companion `anti-drift-controls.md` stated the same controls in prose form; it is retired under the gitops §22 rename form as `anti-drift-controls.deprecated.md` (frozen; superseded by this document), with the retirement recorded in the deprecation ledger (`docs/architecture/transition/deprecations.md`). A stale un-headered original that also remained at the old path after that rename was moved to `docs/archive/anti-drift-controls.md` on 2026-11-09 (#3802), so the old compliance path no longer resolves as a live document. Its one control not previously stated here — zero-FOUC pre-paint hydration — is folded into §2 below.

**Governing Architecture Standards:**
- **Master Enterprise Architecture Standards:** `docs/architecture/standards/standards.md`
- **UX Architecture Specification:** `docs/agents/ux-architecture.md`
- **UX Assessment 01:** `docs/architecture/UX/assessment-01.md`
- **Security Assessment 01:** `docs/architecture/security/assessment/assessment-01.md`
- **Standards Conformance Assessment:** `docs/architecture/standards/assessment/assessment-01.md`

---

## Executive Summary & Anti-Drift Imperative

Software systems experience **drift**—gradual, unplanned divergence from design system tokens, component architectures, security boundaries, and tier abstractions—when developer or autonomous agent changes bypass enforced abstraction layers.

When a UI panel renders a raw `<button>` with custom inline styles (`style={{ padding: "8px 12px" }}`) instead of importing `<Button>` from `src/client/components/ui/`, **UX drift** occurs. When an API route executes direct SQL queries or business logic instead of delegating to domain services or stateful Durable Objects, **architecture drift** occurs. When sub-agents execute tools with ambient orchestrator privileges or outbound webhooks dispatch requests without IP range validation, **security drift** occurs.

This document defines the comprehensive anti-drift framework for NextGenTP across all system tiers, detailing root causes, existing active controls, and mandatory future CI/CD gates required to permanently eliminate drift.

---

## 1. Root Causes of Drift Across Tiers

### A. Client & UX Tier
* **Primitive Bypassing:** Out of 85 TSX/JSX components in `src/client/`, **28 zero-primitive exceptions** and **16 partial exceptions** render raw HTML controls (`<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`) with hand-rolled inline styles instead of importing composable UI primitives from `src/client/components/ui/`.
* **Density Variable Disconnect:** Custom inline styles ignore CSS density tokens (`--control-height`, `--input-padding`, `--table-row-height`, `--card-padding`), breaking compact/comfortable density mode toggles across panels.
* **Accessibility & Focus Ring Omission:** Raw HTML controls lack WAI-ARIA live regions (`aria-live="polite"`), modal focus trapping, and uniform focus rings (`var(--color-focus-ring)`).
* **Ad-Hoc Spacing:** Inline pixel styling bypasses standardized spacing tokens (`var(--space-*)`, `var(--radius-*)`).

### B. Application & Edge Gateway Tier
* **"Fat Routers":** Business logic and validation logic accumulating in HTTP route handlers (`src/server.ts`) rather than delegating to domain services or Durable Objects.
* **Schema Duplication:** Ad-hoc interface definitions in frontend components diverging from backend database schemas.

### C. Agentic AI & Autonomous Workflows Tier
* **Ambient Privilege Escalation:** Sub-agents executing tools under the full system authority of the orchestrator rather than receiving scoped, capability-bound execution tokens.
* **Uncapped Loop Execution:** Autonomous multi-step loops lacking deterministic step caps (`MAS_MAX_STEPS`) or execution timeouts.
* **Unguarded Consequential Actions:** High-consequence agent actions (trades, financial drafts, social posting) attempting direct execution without version-bound Human-In-The-Loop (HITL) approval cards.

### D. Data & Information Governance Tier
* **Manual SQL Tenant Parameterization:** Relying on developer discipline to manually append `WHERE tenant_id = ?` to SQL queries, creating potential cross-tenant state leaks.
* **Fragmented Lifecycle Purging:** Independent data stores (SQLite DOs, Vectorize vector memory, R2 object buckets) lacking a single, unified GDPR / Right-To-Be-Forgotten (RTBF) cascading purge interface.

### E. Security & DevSecOps Tier
* **Outbound SSRF Vectors:** External webhook dispatchers initiating outgoing HTTP requests without rejecting loopback, private, or Cloudflare metadata IP ranges.
* **Bypassed PDP Seams:** Authorization checks performed ad-hoc in endpoints rather than evaluated through a central Policy Decision Point (`iaaaPdpSeam.ts`).
* **Environment Instability:** Non-deterministic CI builds resulting from unpinned runner environments or stale branch bases.

---

## 2. Active Anti-Drift Controls in Codebase

The platform currently enforces automated anti-drift gates across multiple tiers:

| Tier | Active Anti-Drift Control | Implementation Location | Enforcement Mechanism |
|---|---|---|---|
| **UX** | **Zero Raw Color Literal Gate** | `tests/ux_token_coverage_ratchet.test.ts` | Fails CI if raw hex/rgb/hsl colors are added outside `tokens.css`. |
| **UX** | **Design Token Parity Script** | `scripts/gen-design-tokens.mjs --check` | Runs in `npm run check`; verifies `tokens.css` matches `designTokens.ts`. |
| **UX** | **UI Primitives Inventory Pin** | `tests/ui_primitives_inventory.test.ts` | Pin test verifying `src/client/components/ui/` primitive exports. |
| **UX** | **Theme Parity Matrix** | `tests/theme_preferences.test.ts` | Asserts theme token resolution for Light, Dark, System, and High-Contrast. |
| **UX** | **Zero-FOUC Pre-Paint Hydration** | `index.html` (appearance-bootstrap) | Inline script applies theme tokens before initial paint, preventing flash-of-unstyled-theme. |
| **Edge** | **Thin Router Inventory Pin** | `tests/thin_router_inventory.test.ts` | Enforces thin route handlers delegating to services/DOs. |
| **Data** | **Single-Source Schema Pin** | `tests/schema_single_source.test.ts` | Prevents frontend/backend schema drift. |
| **Data** | **Zero KV Security Dependency** | `src/security/sessionStore.ts` | Stores session tokens in SQLite DOs rather than unencrypted KV. |
| **Security**| **Constant-Time Crypto Verification** | `src/security/session.ts` | HMAC-SHA256 signature verification via `crypto.subtle.verify`. |
| **Agentic**| **Judge Model Intent Routing** | `src/agents/judge.ts` | Dual-agent LLM Judge classifies intent and validates tool safety. |
| **Agentic**| **Deterministic Step Caps & HITL** | `src/agents/mas.ts`, `social_approval.ts` | Enforces `MAS_MAX_STEPS` and explicit approval cards for actions. |
| **DevOps**  | **Pre-Merge Rebase & Test Gate** | `scripts/verify-before-merge.sh` | Mandates rebase onto `origin/main` and runs full `npm run check`. |
| **DevOps**  | **Pinned Runner Environment** | `.github/workflows/` | Pins runner OS to `ubuntu-24.04` across all CI pipelines. |

---

## 3. Mandatory Future Controls to Ensure Zero Drift

To permanently eliminate drift across all tiers, the following automated controls MUST be put in place:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │          Comprehensive Anti-Drift Control Architecture  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
        ┌──────────────────────────────────────┼──────────────────────────────────────┐
        ▼                                      ▼                                      ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────────┐
│ UX & Accessibility Controls  │    │ Data & Security Controls     │    │ Agentic & Architecture Gates │
│ • AST Primitive CI Ratchet   │    │ • Central Tenant Repo Wrapper│    │ • Scoped Delegation Tokens   │
│ • Playwright axe-core Gate   │    │ • Outbound Webhook SSRF List │    │ • OpenTelemetry APM Export   │
│ • Density Token Audit Check  │    │ • Unified GDPR Purge API     │    │ • CloudEvents Wrapper Schema │
└──────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────────┘
```

### 1. AST-Based UI Primitive Usage Ratchet (UX Tier)
* **Control:** Extend `tests/ui_primitives_inventory.test.ts` with an AST scanner that fails CI if any TSX component outside `src/client/components/ui/` renders raw `<button>`, `<input>`, `<select>`, `<textarea>`, or `<table>` controls without an explicit exception entry.
* **Ratchet Mechanism:** Maintain a JSON exception allowlist that ratchets downward; any PR adding a new raw HTML control fails build gates automatically.

### 2. Automated WCAG 2.2 AA Accessibility CI Gate (UX / Accessibility Tier)
* **Control:** Integrate `@axe-core/playwright` into Playwright test pipelines to evaluate color contrast, modal focus trapping, minimum touch target sizes ($24\times24\text{px}$ minimum / $44\times44\text{px}$ recommended), and ARIA live announcements on every build.

### 3. Centralized Repository-Level Tenant Context Wrapper (Data / Security Tier)
* **Control:** Wrap DO SQLite statement execution in a mandatory repository interface requiring `TenantContext`. Eliminates ad-hoc `WHERE tenant_id = ?` additions and guarantees 100% data isolation at the ORM layer.

### 4. Outbound Webhook SSRF IP Allowlisting (Security Tier)
* **Control:** Implement IP range validation in `webhookSecurity.ts` rejecting non-routable, loopback (`127.0.0.1`), private RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and Cloudflare internal metadata IPs (`169.254.169.254`).

### 5. Cryptographically Scoped Agent Delegation Tokens (Agentic Tier)
* **Control:** Replace ambient orchestrator permissions with short-lived (60s), signed HMAC invocation tokens passed to sub-agents, explicitly declaring authorized tool capabilities and spend limits.

### 6. Unified Cross-Tier GDPR / RTBF Purge API (Data Tier)
* **Control:** Implement a dedicated `POST /api/v1/privacy/purge-tenant` endpoint executing transactional deletions across DO SQLite tables, purging associated R2 object blobs (`REPORTS_BUCKET`), and deleting Vectorize embeddings by tenant metadata filter.

### 7. OpenTelemetry (OTLP) APM / SIEM Telemetry Export (Ops Tier)
* **Control:** Configure OTLP exporters in `wrangler.jsonc` to stream Workers Observability traces and IAAA audit events to an external APM/SIEM platform (Datadog/Honeycomb/Grafana) for continuous operational monitoring.

### 8. CloudEvents Standard Envelope Wrapper (Integration Tier)
* **Control:** Standardize asynchronous WebSocket and Cloudflare Workflow event payloads to adhere strictly to the CloudEvents v1.0 specification schema (`id`, `source`, `specversion`, `type`, `data`).

---

## 4. Summary Matrix of Anti-Drift Architecture

| Domain / Tier | Primary Cause of Drift | Current Active Controls | Required Future Controls |
|---|---|---|---|
| **UX / Client** | Raw HTML elements, inline styles, un-tokenized spacing | `ux_token_coverage_ratchet`, `gen-design-tokens.mjs --check` | AST Primitive Usage Ratchet, `@axe-core` WCAG 2.2 AA Gate |
| **Edge Gateway** | Fat route handlers, inline business logic | `thin_router_inventory.test.ts` | API Contract OpenAPI / Zod AST Verification Gate |
| **Agentic AI** | Ambient permissions, uncapped execution loops | `MAS_MAX_STEPS`, Judge Router, Payments HITL | Cryptographically Scoped Sub-Agent Delegation Tokens |
| **Data Tier** | Manual SQL `tenant_id` filtering, un-cascaded deletes | `schema_single_source.test.ts`, SQLite DOs | Central Repository Tenant Wrapper, Unified RTBF Purge API |
| **Security** | Un-whitelisted webhooks, bypassed PDP seams | HMAC signatures, Constant-time crypto, Gitleaks | Outbound Webhook SSRF IP Range Filtering |
| **DevOps / Infra**| Stale bases, unpinned CI environments | `verify-before-merge.sh`, `ubuntu-24.04` pin | Automated OpenTelemetry (OTLP) APM / SIEM Export |

---

## Conclusion & Verification Commands

All future platform enhancements must maintain compliance with these anti-drift controls and pass mandatory verification commands before merging:
- `npm run check`
- `npx vitest run tests/ui_primitives_inventory.test.ts`
- `npx vitest run tests/ux_token_coverage_ratchet.test.ts`
- `npx vitest run tests/thin_router_inventory.test.ts`
- `npx vitest run tests/schema_single_source.test.ts`
