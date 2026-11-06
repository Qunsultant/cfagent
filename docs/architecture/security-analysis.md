> **Recovered report — written in PR #1828 (2026-10-26), recovered in #3461 (2026-11-06).**
>
> This analysis was reviewed in PR #1828 and never reached `main`. It is recovered here rather than
> re-written, with the verification recorded below.
>
> **Authority rule:** where this document and the code disagree, the code, the tests and the ADRs under
> [`adr/`](adr/) are current. This is a dated snapshot, not a specification.
>
> **Verified on recovery (2026-11-06):** the enforcement points it cites still exist on `main` —
> `isSessionIdFormat`, `validateAndTouchWiredSession`, `requiresStepUpForMint`,
> `IAAA_PDP_ENABLED` and `docs/THREAT_MODEL.md`. The threat list is unchanged since it mirrors that
> model.
# Full Security Analysis Report

## Executive Summary

This document delivers a thorough security analysis of **cfagent**, evaluating its threat profile, identity architecture, perimeter defenses, prompt injection guardrails, Human-In-The-Loop (HITL) safety controls, and supply chain security. The platform implements multi-layer defense-in-depth across the Cloudflare Worker edge runtime, Durable Objects, and LLM orchestration tools.

---

## 1. Threat Profile & Surface Identification

As documented in `docs/THREAT_MODEL.md`, the platform defends against six critical threat vectors:

1. **T1 — Forged Inbound Webhooks**: Untrusted HTTP POSTs attempting to forge broker alerts or NLQ execution.
2. **T2 — Replay Attacks**: Recaptured valid signed webhooks double-executing trade orders or payment transfers.
3. **T3 — Natural Language Query (NLQ) Exfiltration**: Malicious prompt queries attempting to inspect SQLite system tables (`sqlite_master`) or exfiltrate private data via email.
4. **T4 — Server-Side Request Forgery (SSRF)**: Webhook callback URLs reaching internal metadata or loopback endpoints.
5. **T5 — Email/Social Spoofing**: Unauthenticated trade executions or phishing via forged outbound reports.
6. **T6 — Credential / Secret Exposure**: Leakage of API keys, OAuth tokens, or signing secrets through code repositories, error outputs, or logs.

---

## 2. Identity, Authentication & Policy Enforcement (IAAA)

### 2.1 Multi-Provider OAuth 2.0 & Session Management
- **OAuth Providers**: GitHub and Google OAuth 2.0 authentication (`src/security/providers.ts`).
- **CSRF & State Security**: OAuth `state` parameters are verified using constant-time HMAC-SHA256 signatures derived from `SESSION_SECRET` with expiration timestamps.
- **Session Persistence**: Sessions are stored in the high-performance `SessionStore` DO (`src/security/sessionStore.ts`). Session cookies carry `HttpOnly`, `Secure`, and `SameSite=Lax` flags.
- **Session Validation**: Session IDs undergo strict UUID format validation (`isSessionIdFormat`) to avoid unneeded database reads on invalid cookies. Wired sessions undergo touch and absolute/idle lifetime checks (`validateAndTouchWiredSession`).

### 2.2 Role-Based Access Control (RBAC) & PDP
- **Policy Decision Point (PDP)**: Managed by `IAAA_PDP_ENABLED` in `src/security/iaaaGithubEndToEnd.ts`.
- **Role Hierarchy**: Supports `platform-admin`, `tenant-admin`, `trader`, and `viewer` roles.
- **Integration Gates**: Sensitive operations (e.g., `/auth/etrade/start`, verifier exchange, API key minting) require explicit permissions (such as `integration:connect`).
- **Step-Up Authentication**: Minting per-user API keys (`src/security/apiKeys.ts`) requires fresh authentication (`requiresStepUpForMint`), rejecting stale sessions.

---

## 3. Perimeter & Edge Network Controls

### 3.1 Cross-Site WebSocket Hijacking (CSWSH) & CORS
- **CSWSH Defense**: WebSockets and REST requests enforce strict `Origin` header validation (`isAllowedOrigin` in `src/server.ts`), restricting requests to configured domains (`APP_BASE_URL`, `agent.openaimp.com`, `localhost`).
- **CORS Configuration**: Restrictive `Access-Control-Allow-Origin` and explicit allowed headers (`PAYMENT-SIGNATURE`, `Authorization`) on public/paid endpoints.

### 3.2 Abuse Mitigation & Rate Limiting
- **Edge Rate Limiting**: The sliding-window rate limiter (`src/security/rateLimiter.ts`) throttles sensitive ingress routes (`/nlq/webhook`, `/mcp`, `/api/memory/search`).
- **Payload Size Capping**: Inbound webhooks strictly cap payload sizes (e.g., 128 KB for `/nlq/webhook`, 4,000 characters for NLQ text).
- **Fail-Closed Secret Enforcement**: Unconfigured secrets (`INBOUND_NLQ_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`) result in immediate HTTP 503 Service Unavailable responses rather than bypassing authentication.

---

## 4. Application & LLM Security Controls

### 4.1 Prompt Injection Isolation (`<<<UNTRUSTED_...>>>`)
To prevent prompt injection attacks from retrieved documents, inbound emails, or news feeds from hijacking LLM instructions, content is isolated using structural delimiters:

| Untrusted Channel | Separation Mechanism | Implementation Reference |
|---|---|---|
| **Inbound Email → NLQ** | Wrapped in `<<<UNTRUSTED_EMAIL_CONTENT>>>` with defused end-markers | `src/agents/nlq/llmPlanning.ts` |
| **Retrieved RAG Context** | Wrapped in `<<<UNTRUSTED_RETRIEVED_CONTENT>>>` | `src/agents/orchestrator.ts`, `src/agents/chatPrompt.ts` |
| **News Sentiment Input** | Wrapped in `<<<UNTRUSTED_NEWS_CONTENT>>>` | `src/trading/options/flows/newsSentiment.ts` |
| **Options Ideas Ranking** | Wrapped in `<<<UNTRUSTED_GROUP_ANALYSES>>>` | `src/trading/options/llmIdeas.ts` |

### 4.2 NLQ Execution Allowlist & SQL Parameterization
- **25-Table Allowlist**: `NLQ_TABLE_ALLOWLIST` in `src/agents/nlq.ts` limits natural language SQL generation to safe domain tables. Queries targeting `sqlite_master` or system catalogs are blocked.
- **Parameter-Bound SQL**: All query execution uses parameterized queries (`sql` tag or `prepare().bind()`), preventing SQL injection.

---

## 5. Human-In-The-Loop (HITL) Guardrails

State-changing money movements and trade executions enforce strict HITL confirmation:

1. **Trade Drafts & Confirmation Cards**: Automated agent reasoning drafts order previews (`preview_order`). Trades cannot execute without an explicit human confirmation (`confirmDraft`, `confirmationCard.ts`).
2. **Payment Intents**: Payments draft charges, refunds, or invoices requiring explicit UI or Slack approval.
3. **Outbound Email Allowlisting**: The optional email delivery leg validates `emailTo` against `EMAIL_TO_ALLOWED_DOMAINS`. Order previews or execution actions are never emailed out (`emailDelivery: "not sent for an action request"`).

---

## 6. Secrets Hygiene & Supply Chain Security

- **Automated Gitleaks Scanning**: Full repository history and PR commits undergo Gitleaks scanning (`.gitleaks.toml`, `.gitleaksignore`).
- **Secrets Management**: Live credentials (e.g., `SESSION_SECRET`, `GH_CLIENT_SECRET`, `INBOUND_NLQ_WEBHOOK_SECRET`) pass solely through GitHub Actions environment secrets and Wrangler secret bindings.
- **Timing-Safe HMAC Comparison**: Cryptographic signatures use timing-safe comparison (`crypto.subtle.verify` or `timingSafeEqual`) to prevent timing side-channel attacks.

---

## 7. Security Recommendations

1. **Mandate `EMAIL_TO_ALLOWED_DOMAINS` in Production**: Ensure operators configure explicit domain allowlists in production deployments to prevent arbitrary email dispatch.
2. **Audit Outbound Webhook Whitelisting**: Periodically review `assertSafeOutboundWebhookUrl` to enforce private IP subnet blocks (`10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`) against evolving cloud network topologies.
