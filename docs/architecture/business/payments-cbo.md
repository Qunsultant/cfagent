# Payments + commercial platform — the CBO domain

- **Status:** domain record, 2026-11-18. **Verified against:** `origin/main` at `0cb94f214e3595d804960a0ae2963862717eb887` (fetched 2026-11-18). File:line citations were verified on `46b6537d6`; the commits since touch only survey docs, the changelog, the census baseline test, and the leaf-id minter — none affects the cited files.
- **Owner direction:** Mars, 2026-11-18 — integrate the documents shared in the CBO chat recently into one doc for the domain, kept here. This file is that synthesis. It summarizes and points; it does not duplicate the sibling docs or the evidence archive.
- **Method:** static code + issue-body reads only. No runtime, live-state, or signed-in verification was done for the underlying inventories; where a claim needs a live check, this doc says so instead of asserting it.

## 1. Purpose and scope

This doc is the single entry point for the CBO (Chief Business Officer) domain: paid screener runs, subscriptions, credits, referral codes, upgrade offers, refunds, and the platform administration surfaces (tenants, accounts, channels, free runs, products) through which operators run them — plus the chat surface (BizCopilot) that is being brought to parity with those pages, and the API layer that serves all of them.

Scope boundaries, stated so the doc is not over-read:

- **In scope:** the commercial route family, the platform tenants/accounts/channels/users routes, the legacy payments routes, the premium x402-gated endpoints, the payment-assurance routes, the meter route, and the BizCopilot chat surface over them. The journal projection and the failure-credit claim mechanism, as accounting records.
- **Out of scope (other lanes own them):** trading and the order ticket (CPO); research jobs and the job/pipeline engine (J-stack); the cross-domain paid-screener-to-trade saga (CAIO, #2041) except where its payment gate and meter touch this domain; identity/authorization internals (CISO owns IAAA); bundling (COO, #2781); the broker order ledger tab (a trading surface, not the commercial ledger).
- **Rules live elsewhere; this doc links.** Entitlement rules live in [entitlements-01.md](entitlements-01.md). The entity model lives in [platform-entity-capability-map.md](platform-entity-capability-map.md). Identity and authorization models live in [api-security.md](../security/api-security.md), [authn.md](../security/authn.md), and [authz.md](../security/authz.md). The API/MCP architecture of record is [api-mcp.md](../application/api-mcp.md). The container architecture doc is [ADD.md](../ADD.md). The full flow, route, and compliance tables live in the evidence archive (§10).

## 2. Correction — the parity report's §G citations

The parity inventory's §G (AOP compliance) cites rule sources that **do not exist under those names**. Verified 2026-11-18 against `origin/main`: these files are absent, and the ADR numbers name different subjects (0007 is hybrid-rag, 0009 is telemetry-calibration, 0018 is caio-alignment):

- `docs/architecture/adr/0018-error-handling.md`, `docs/architecture/adr/0009-coded-messages.md`, `docs/architecture/adr/0007-security.md`
- `docs/architecture/standards/security.md`, `docs/architecture/standards/error-handling.md`, `docs/architecture/standards/message-codes.md`, `docs/architecture/standards/logging.md`

The §G **code findings** (file:line evidence) stand where verified; the **rule-source citations do not** and must never be repeated. This doc cites only real sources: the security docs named in §1, [standards.md](../standards/standards.md), ADR 0002 (data foundation), ADR 0012 (MCP tool permissions), ADD.md, `api-mcp.md`, and code file:line. The survey archive keeps the inventory verbatim, including the wrong citations; this doc is the corrected record.

## 3. Domain model

### 3.1 Entities

The model, summarized from [platform-entity-capability-map.md](platform-entity-capability-map.md) (which governs; this section does not re-decide it):

- **Login (user).** Identity is a verified login string from the session. There is no user table. A login may have a wired alias (`internalUserId`); unwired logins still get identity and account views.
- **Account.** One commercial row per login, keyed by login, carrying exactly one `tenantId`, plus `tier`, `tierSource`, `creditsUSD`, `includedRuns`. A missing row is not an error — it resolves to implicit Free. A login cannot hold two commercial accounts and therefore cannot have two account tenants.
- **Tenant.** A referenced id, not a row. A tenant exists wherever its id is referenced (account rows, tenant-settings rows, IAAA memberships). Enumeration is derived (distinct `tenantId`s across account rows UNION settings rows). There is no tenant lifecycle state.
- **Membership (IAAA).** The authorization layer and the second tenant authority. One login can belong to multiple tenants via memberships. Membership writes are CISO-lane owned, with a hard no-self-grant rule; the tenant admin surface displays memberships read-only and never writes IAAA state.
- **Platform.** Not an entity with rows: the app console (the `platform-admin` tab) and the scope string `"platform"` in IAAA role bindings.
- **Product and version.** A product is an identity row (`agent_products`); a version is a plan row (subscription products) or a catalogue row (per-run products) carrying `productId`, `segment`, `version`, and effective dates. Products are global operator data. A price change is a new version; a new version moves no one by itself (holders stay grandfathered until moved). See §3.4.
- **Native ledger / journal / subscriptions / refunds** carry `tenantId`. Credit claims and paid submissions do not (see the entity map §4 for the per-entity dimensions).
- **Session-scoped always** (owner correction, 2026-10-29): no branch anywhere, free or paid, may use a client-supplied `tenantId` for scoping. Scope always derives from the verified session login. No anonymous tenant is ever invented. One verified violation of this rule exists in the lifecycle preference routes (§6.3).

### 3.2 Tiers, allowances, and prices

Full rules: [entitlements-01.md](entitlements-01.md). Summary:

- **Stored tiers:** `Free | PayPerUse | Subscribed`, plus `tierSource` (`operator | subscription | null`). **Effective tier resolves at read time:** any subscription row with `periodEndMs > nowMs` confers `Subscribed`; no account resolves to `Free`.
- **Allowances** (owner-decided 2026-11-05, operator-managed data, changeable, never constants): Free 10, Basic 20, Premium 30 runs per product per month. Tiers are cumulative. Nothing runs over allowance — at the limit, the user is asked to upgrade or buy credits.
- **Subscription prices APPROVED** (owner, 2026-11-05): Free $0, Basic $49.99/month, Premium $59.99/month, with grandfathering. Prices are fully flexible operator data (owner, 2026-11-11): annual figures are proposed seeds, never fixed approved prices.
- **Per-run prices NOT approved.** Seeds stay PROPOSED (stock $0.02, options $0.05, research $0.10; goal/strategy $0.10 catalogue-only PROPOSED). Only an APPROVED catalogue price can charge; a missing or unapproved price fails closed. Price-approval state is mechanized (#2547): gates refuse unapproved prices.
- **Selective administration** (owner, 2026-11-05): unlimited-free grants and per-run price approvals are selective by platform and/or tenant admin. None granted or approved yet; no real account is granted until the owner names it.
- **Multi-tenant rule** (owner, 2026-11-05): each user keeps their own subscription within a tenant; subscriptions are (user, tenant)-scoped and do not carry across tenants.
- **Conformance point (open):** the chat paid path reads a raw catalogue price with no approval check while the HTTP gates fail closed (entitlements-01.md §8). That is an open conformance point, not a second approved path.

### 3.3 The gate (the only entitlement path)

Every paid-screen run goes through one gate, the native monetization gate (`src/services/nativeMonetization.ts`, `NativeMonetizationGate.check()`), reached through the paid-screen submission seam (`src/services/paidScreenSubmission.ts`). The gate consumes coverage only through `check()` / `confirmPaid()`. There is no second entitlement path. Gate order, as shipped (entitlements-01.md §2.1 governs):

1. Verified identity required; tenant mismatch throws. An existing paid row returns `already_paid`.
2. Flag OFF → free, price 0, no price resolution. (Monetization is a Flagship ON/OFF feature; default ON in code since 2026-11-01 — a code default only. No live charge is verified.)
3. Unlimited-free grant, bounded by the approved-free quota (#3263): an active grant covers the run within its per-service quota (default 10 runs per service per month, operator data). At the cap the run is refused with the outcome-coded at-limit decision and no checkout is minted. "Unlimited" means no payment is needed, not unlimited runs — the bound is the grant's meaning (owner-delegated decision, 2026-11-18; stated in entitlements-01.md).
4. Free allowance (#3305): 10 runs per product per UTC calendar month, operator-managed.
5. Unlimited-free grant as the last free fall-through (covers the run at price 0, consuming nothing; never fails on a missing/unapproved family price; covers recurring runs).
6. Price resolution via `priceFor()`: only an APPROVED catalogue price charges; missing/unapproved/invalid throws fail-closed.
7. Coverage, in order: Subscribed included runs → code runs (#3307; only when the family price is approved; no journal entry) → runs-pack runs (#3246; same approval precondition) → credits (`creditsUSD >= price`, cent-rounded) → no coverage.
8. Scheduled, not one-off-authorized → `coverage_required`, HTTP 402. No unattended card charge is ever taken.
9. Manual / one-off-authorized, uncovered → checkout minted (Stripe card or x402; no checkout ports → throw fail-closed), returned as 402 `payment_required` with the checkout attached.

The money path knows only `manual | scheduled` triggers. "Triggered" (an on-demand user invocation of a scheduled run, tracked as user-involved) is decided but unbuilt as a distinct tracked trigger.

**Failure credits:** a failed paid run issues a one-time replacement-run credit (never a cash refund). The credit path throws when `priceUSD <= 0` (the $0-run edge, a known open edge). A failed code-covered run issues NO failure credit — a free run has no charge to reverse.

**Trials:** a trial grants the trial plan's `includedRuns` for the trial period (`trialDays` is per-plan/version operator data; null means no trial). The Stripe Billing purchase route confers tier only, never included runs — a trialing subscription with zero included runs enables nothing until runs are granted. At trial end the tier lapses to the stored tier; leftover runs are not clawed back but are spendable only while Subscribed again (accepted as built behavior, 2026-11-18; per-source clawback machinery is unbuilt).

### 3.4 Products, versions, and offers

- **Product versions** (#3289, closed 2026-11-12): products are identity, versions are immutable terms snapshots; plan/catalogue rows ARE versions (migration 0058). A price change is a new version with an effective date. Per-run resolves the effective catalogue version. Moves are per-customer (Accounts panel) and bulk ("move all to current pricing", Products section), segment-aware (free-form `segment` column, default `"default"`, no registry), audited (`agent_version_moves`, `agent_bulk_moves`). In-flight periods run to end; runs/credits untouched; no proration. Every charge records productId + versionId + priceUSD (journal, native ledger, claims).
- **Upgrade offers** (#3246, closed 2026-11-13): server-computed, read-only (current vs higher approved versions), actions into existing checkout, never stored. Activation stacks (extends period + adds runs; nothing replaced/converted/prorated). Acceptance only via the native one-time purchase route. Standalone included-runs purchases supported. Dismissal/cooldown required in v1 (seed 7 days). PROPOSED plans shown as unavailable. Downgrades included (buy-lower via the native route, no cancel/proration). Runs packs are a `runs_pack` product kind with approval-gated (runs, price) versions, a dedicated balance, no expiry, family-agnostic. Rank is an explicit operator column on `agent_products`, rank-first with a derived fallback.
- **Free access** (#3247, closed 2026-11-13): free-for-lifetime (access free forever; any activity requires payment) plus a free-for-a-limited-time variant, configurable/revocable. Operator grant/revoke only in v1; the self-service claim flow is deferred. No live grant made.
- **Referral/invite codes** (#3307, closed 2026-11-13): extra free runs on top of sign-up and grants. All rules configurable from the UI per product (issuer, runs, one-time vs reusable, expiry, attribution, abuse limits). Seeds PROPOSED/inactive until an operator activates a rule. Codes are stored as SHA-256 hash only; plaintext is returned once, never again. No live code issued or redeemed yet.
- **Monthly + annual** (#3357, built and closed 2026-11-06): annual derivation at an operator-managed discount (PROPOSED seed 15%).
- **Bundling:** none. COO #2781 is open, unbuilt, COO lane.

### 3.5 Journal and ledger

- **Minimal double-entry journal** (owner decision, 2026-10-28), to be replaced by a real general-ledger system later, behind `JournalPort` with a D1 adapter now (ADR 0002 port-first). The journal is a projection of the Durable Object ledger: the DO ledger is authoritative; journal write failures are loud-logged and never fail a payment; reconcile, no auto-correction. Rows live ONLY in D1 (never in the broker-transactions table, never as micropayment rows).
- **Chart:** 1000 Funds received, 2000 Customer credits outstanding, 4000 Revenue — screener runs, 5000 Refunds contra-revenue (reserved). Mappings: charge Dr 1000 / Cr 4000; failure credit Dr 4000 / Cr 2000; redemption Dr 2000 / Cr 4000. Subscription/deferred-revenue mapping is a later slice.
- **No HTTP routes exist for the journal or for failure-credit claims** (verified by the route inventory). The journal is written inside purchase/confirm/submit handlers; claims are created by the payment workflow and redeemed inside the submit route. Verification of a purchase via API is through the usage-billing and subscription reads, not the journal. A journal read route would be a new capability, filed only if the owner wants journal verification via API.
- **The broker order ledger** (`?tab=ledger`: overview + per-broker tabs, broker + mode columns, sortable, 50-row cap) is a different ledger and a trading surface; it is out of this domain's scope except as a neighboring read surface.

### 3.6 Platform surfaces

Deployed app URLs (admin-gated where applicable; chat is the first interface for BizCopilot):

- Platform Admin: `?tab=platform-admin&view=tenants`, `view=accounts`, `view=channels`, `view=free-runs`, `view=products`
- `?tab=checkout`, `?tab=billing`, `?tab=payment-assurance`, `?tab=chat`, `?tab=ledger`
- 134 HTTP-issuing UX action rows were enumerated from code (114 CBO commercial/platform actions excluding two broker surfaces). The per-action table is evidence (§10); the flow inventory (§4) is the discrete-flow view of the same surfaces.

## 4. Flow inventory and chat/UX parity

### 4.1 The 104 discrete flows

The 2026-11-18 parity inventory enumerated **104 discrete user flows** (F01–F104) across the CBO surfaces: 90 simple (single route call), 13 composed (multi-step), 1 refusal by design (F06, membership writes — correctly refused; never build). 104 is a FLOW count, not an API count. The full per-flow table (UX surface, route, chat state, covering issue, complexity) is evidence (§10).

Parity state at inventory time:

| Surface | Flows | Chat-covered (deterministic) | Chat-covered (MCP) | No chat path |
|---|---|---|---|---|
| Tenants | 7 | 5 | 0 | 0 (1 refusal, 1 reconcile) |
| Accounts | 15 | 8 | 0 | 5 (2 out of parity scope) |
| Channels | 6 | 4 | 0 | 2 (API-only decisions) |
| Free runs | 5 | 0 | 0 | 5 |
| Products | 19 | 0 | 0 | 17 (1 reconcile, 1 cross-lane) |
| Referral self-service | 6 | 0 | 0 | 6 |
| Offer rules / billing policy | 4 | 0 | 0 | 4 |
| Usage billing | 1 | 0 | 0 | 1 |
| Checkout | 16 | 0 | 0 | 15 (1 cross-lane) |
| Payments / wallet | 7 | 0 | 3 full + 1 partial | 2 (1 reconcile) |
| Billing servicing / refunds | 7 | 0 | 0 | 3 (4 excluded, decision-gated) |
| Assurance / prices / operators | 8 | 0 | 0 | 8 |
| Legacy community / ads | 3 | 0 | 3 | 0 |
| **Total** | **104** | **17** | **6 full + 1 partial** | **68** |

Headline: 17 of 104 flows reachable deterministically, 6 more via legacy MCP tools, 1 partially; 68 with no chat path. Of the 68 gaps, 46 were covered by an existing filed slice issue (#4518–#4522), 22 had no covering issue, 6 carried a governance decision flag, and 4 were API-only routes needing a surface decision. Zero CBO-surface MCP tools exist — the MCP coverage above is all legacy tools in other worlds (payment drafts, community referrals, ads, revenue); none calls a CBO commercial route.

### 4.2 BizCopilot state

BizCopilot (owner direction, 2026-11-14) is modeled on StockCopilot: chat-first at `?tab=chat` (NLQ explicitly not the first interface); the user performs all commercial/platform activities through chat and views results via clickable URLs to the relevant pages; gates unchanged; pages stay; one chat copilot shell, no second copilot.

- **Slices 1–3 built and closed 2026-11-15** (deterministic branches whose executors call page routes and never touch the job engine): #4515 Tenants, #4516 Accounts, #4517 Channels. Copilot card / Docs dispatch is configuration-only — no dispatch exists and none is faked (#3178 owns that decision).
- **Mechanism decision** (owner, 2026-11-15): MCP tools via the LLM are the PRIMARY path through BizCopilot chat; deterministic branches stay as an option and are not removed. Conversion issues #4741 (tenants), #4742 (accounts), #4743 (channels) are filed under umbrella #4514, file-only, no build directed. The executors are separable from the regex parsers, so conversion reuses gates and audit verbatim. Still open: the permission-visibility check for non-operators (tools auto-merge into every turn; route gates refuse non-operators today).
- **Slices 4–8** (#4518 Free Runs, #4519 Products, #4520 Checkout, #4521 Billing, #4522 Payment assurance) were unbuilt at inventory time and are now sequenced through the parity program (§4.3). The one-surface rule governs: an MCP tool reuses the route's executor (no second implementation); a deterministic branch and an MCP tool over the same flows share the executor.
- **Chat architecture (verified):** the chat tab talks to one agent, OrchestratorAgent, with an MCP client to the platform's own MCP server via loopback; tools auto-merge into the turn. BizCopilot does not run on the job/pipeline engine. Sync/async is a job execution-mode dimension, not a BizCopilot command property.
- **Chip/parser lesson** (#4701, fixed 2026-11-15): a shipped quick chip must send a prompt its parser accepts. A bare "Create a tenant" chip fell through to the model, which falsely denied the capability. The fix made all three parsers return deterministic ask outcomes and pins every chip prompt against parser acceptance.

### 4.3 Quick wins, tracker, and sequencing

Filed 2026-11-18 (verified by read-back):

- **Tracker #5306** (`[BizCopilot] Chat/UX full-parity tracker`), under #4514: carries the inventory, the sequencing, and the gated decisions. Nothing gated gets built on a guess.
- **QW-1 #5307** — Free Runs via MCP (F29–F33; decomposes all of #4518). **QW-2 #5308** — Billing state reads via MCP (F63/F72/F87/F88/F93/F53/F54; read-only). **QW-3 #5309** — Products reads + rank via MCP (F34/F44/F46/F48/F50/F41). **QW-4 #5310** — Payment assurance runs via MCP (F94–F97; decomposes all of #4522). All four Reuse class enhancement, MCP-primary with the deterministic option, each with 8 full-stack sub-issues (#5311–#5342).
- **Sequencing:** quick wins → batch 2 (referral self-service, product writes, offer present/dismiss, checkout prepare, account gaps) → batch 3 (checkout confirm, bulk moves, operators, prices, policy, receipts, cancel, channel bindings) → decision-gated work only after the owner's calls. Reads before writes; operator config before money movement; highest-frequency questions first.
- **Reconcile, not parity:** F07 (commercial tenant-settings, no caller), F51 (legacy plans, superseded by versions), F84 (PayPal capture, no UX) need a reconcile-or-deprecate decision, not chat parity. Cross-lane items (bundles, saga, users/IAAA, premium stock-signals) stay with their owning lanes.

### 4.4 Decisions gating parity work

Carried on tracker #5306, not decided in this doc: Checkout capture scope (#4520 — the model prepares and presents while capture/confirm stay on the existing deterministic flow); price/version approval via chat (F39/F100); plaintext-once code issue via chat (F47/F55 — transcript persistence question); refund execution via chat (F89–F92, currently excluded by #4521); cfpay channel purchase (F75 — the cfpay gate is deprecated in place); bulk-move confirmation in chat vs page-only; non-operator MCP permission visibility; API-only routes (F27/F28/F79/F86 — chat-first or leave API-only).

### 4.5 Composability limits

- **Journal verification and failure-credit claims** cannot be composed via API: no routes exist (§3.5). Verify via the usage-billing and subscription reads.
- **Plaintext-once codes** (F47/F55) cannot be re-read by design; "issue, then show later" is impossible.
- **HITL chains** (draft→confirm, refund request→approve→execute, saga gates) compose only with a human pause; the model prepares, presents, and resumes — it never completes the chain alone. No prompt sits in the money path.
- **No-id responses** (9 routes, §5.1) compose by re-read, not by id.
- **Bulk moves** are synchronous with a row cap; large moves resume via `resumeBulkMoveId`.

## 5. API inventory

### 5.1 The 150 routes

CBO-scope HTTP routes inventoried 2026-11-18: **150 method+path rows** in 12 groups. The full per-route table (handler file:line, gate, request/response, client caller) is evidence (§10).

| Group | Routes | Handler file |
|---|---|---|
| Wallet + ledger | 10 | `src/agents/routes/agenticPayments.ts` |
| Catalogued commercial | 87 | `agenticPayments.ts` (9,043 lines on the verification tip) |
| Parameterized commercial, uncatalogued | 10 | `agenticPayments.ts` |
| Legacy payments | 9 | `src/agents/routes/payments.ts` |
| Platform accounts / onboarding / profile | 7 | `src/agents/routes/platformAccounts.ts` |
| Tenants | 4 | `src/agents/routes/platformTenants.ts` |
| Channels | 6 | `src/agents/routes/platformChannels.ts` |
| Users (CISO-owned reads) | 2 | `src/agents/routes/platformUsers.ts` |
| Assurance | 4 | `src/agents/routes/paymentAssuranceLive.ts` |
| Premium (x402-gated) | 6 | `src/agents/routes/premiumHandlers.ts` |
| Saga (CAIO-owned) | 4 | Saga handler modules |
| Meter (internal-only) | 1 | `src/agents/routes/premiumMeters.ts` |

41 routes have no client caller found (6 by design: webhooks, meter, unsubscribe, internal ledger rows). 9 routes return no identifier for the thing they create or change. The commercial family also answers a bare spelling alias (`/payments/agentic/commercial/*`); handlers match with `path.endsWith(...)`, so both spellings hit the same block.

### 5.2 Dispatch (hand-rolled, no router)

`src/server.ts` `handleFetch` runs family handlers in order: saga routes first (Worker edge), then the payments family (`src/server/routes/platform.ts:472`), then the generic `/api/*` fallthrough (`src/server/routes/core.ts:156`), each forwarding to the caller's OrchestratorAgent Durable Object instance. Inside the DO, `src/agents/orchestrator/routeRequest.ts` calls per-module handlers in a fixed sequence (payments → assurance → agentic-payments → platform users/tenants/accounts/channels → premium), each running its own sequential `if` chain. Dispatch order is load-bearing — later modules only see requests earlier modules declined — and dispatch order is a security property ([api-security.md](../security/api-security.md) §1): a route that moves above the session check in a refactor has silently become public.

### 5.3 No separately designed API layer (verified verdict)

There is no separately designed "CBO API" layer, no shared commercial/platform router module, no API versioning on any commercial/platform route, and no OpenAPI description of the commercial routes. What exists instead:

- A **path-only catalog**, `src/data/commercialUrlCatalog.ts` — the single source of truth for commercial paths only (it does not cover the 10 parameterized routes or any non-commercial group). It performs no routing, no auth, and no versioning. A pin test fails on hardcoded commercial literals or handler/catalog drift.
- A **static endpoint catalog** for the IAAA explorer (`src/client/iaaaEndpointCatalog.ts`) — the entire commercial family is one prefix entry; it serves a read-only panel, not requests.
- An **OpenAPI spike** (`src/security/openapiSpec.ts`) — pilot schemas only; every commercial route carries "schema: not yet specified". Served session-gated at `/openapi.json` + `/api/docs`.
- **Ingress guards** (`src/api/ingress.ts`) that explicitly decline a router table — the header names the router-table extraction as the follow-up.
- Shared pieces only as helpers inside `agenticPayments.ts` (login/operator/flag checks, coded responses) plus the outcome catalog.

The APIs are a per-slice accumulation behind one hand-rolled dispatcher, not a designed layer. The API-layer program (§6.4, §9) exists to design the layer; parity work must not add a second accumulation.

### 5.4 Domain → module → API mapping: none designed

- **Domains:** 21 entries in the issue taxonomy (D-1–D-21: Research, Trading, Payment, plus 16 platforms, Channels, Other). That is a classification taxonomy for issues, not a code structure. CBO scope is Payment (D-3) and the CBO platform (D-5).
- **Modules:** by file count on the verification tip — 307 services, 82 route files, 434 data files, 80 security modules, 28 MCP `openaimp` files, 44 agent files, 384 client files. There is no module manifest; "module" is a file/directory by convention.
- **Mapping:** no designed domain→module→API mapping exists. The de-facto mapping is dispatch order + file naming + the path catalog. The API-layer design must define the mapping and the granularity policy; this doc records the gap rather than inventing the map.

### 5.5 Granularity: fine-grained, action-style

One POST per action (record, grant, revoke, approve, move, dismiss), 150 routes serving 104 flows. Composition lives in the caller — panels and chat call several endpoints per flow. The MCP side matches: roughly 100 tools, one scope per tool. There are no coarse resource endpoints and no versioning. Whether any flows should compose server-side (coarser endpoints) is a design decision for the API layer, not a premise of this doc.

## 6. Security model

### 6.1 Identity

- **IAAA identity:** `(issuer, subject)` maps to a stable internal user id (`src/security/identityBinding.ts`). Email is never identity; a login string is never identity (renameable, recyclable). Sessions carry `internalUserId`, `providerIssuer`, `providerSubject`, `authTimeMs`, `sessionVersion`. See [authn.md](../security/authn.md).
- **Dispatcher-minted session identity:** the Worker dispatcher requires a session (`requireAuth`, 401 without one) and sets `x-user-login` from the verified session, overwriting anything the caller sent (`src/server/routes/platform.ts:472–475`, `src/server/routes/core.ts`). No handler needs to distrust `x-user-login`; the dispatcher is the single minting point.
- **Service identity:** `SERVICE_USER_LOGIN` via `getServiceUserLogin` (`src/security/serviceIdentity.ts`, #1185) is the explicit service identity **for unattended/background work only** (worker `scheduled()`/`queue()`, session-less entry points). When unconfigured, there is no unattended identity — callers skip and log rather than substitute. The service user's internal id is `service:<login>`; it never logs in.
- **API keys:** per-user `cfk_` keys (`src/security/apiKeys.ts`) are the non-session credential for programmatic access, notably the MCP transport. Mint is step-up gated; list and revoke are deliberately ungated (revocation must never be blocked by the freshness rule it escapes from). Keys are bearer-equivalent within scope. See [api-security.md](../security/api-security.md) §3 and `mcp-security.md`.
- **Background attribution:** `src/security/backgroundAttribution.ts` names the actor kind (`background` vs `user`) for audit and logs. It changes no enforcement: the service-dispatch rule remains the gate for internal dispatches, and attribution authority is never the header alone.

### 6.2 Per-surface reality (verified 2026-11-18)

There is **no single enforced security model today**. There is one designed model — IAAA — whose enforcement is staged and incomplete. The honest per-surface picture:

- **APIs:** dispatcher session gate + per-file handler gates. The commercial handler defines `commercialLogin()` (:841), `isStoreOperator()` (:875; env `COMMERCIAL_STORE_OPERATORS` UNION the store list, empty = deny all), and `canAccessAccount()` (:907; owner-or-operator) as in-file closures; the platform route files each re-implement the operator check. One model, N implementations — consolidation is a hardening target. The PDP `authorize()` is **not** wired into any route (see below).
- **IAAA / PDP:** `authorize()` (`src/security/authorization.ts`, #945 Slice 3) is **pure policy, deliberately not live enforcement** — its header states it touches no route, API, job, tool, or storage backend, and a later slice wires it into live call sites. It is default-deny, role-based (platform-admin, tenant-admin, workspace-admin, member, approver, auditor), over **17 permissions** (membership, role, task, artifact, integration, action, audit). **No money/ledger permission exists.** The service user carries no PDP permission. `system:` actors exist only as provenance strings (`system:bootstrap`, `system:auto-provision`), never as principals holding bindings. See [authz.md](../security/authz.md).
- **MCPs:** ADR 0012 (accepted) defines port-first per-tool scopes (`src/mcps/openaimp/mcpPermissionPorts.ts`): six scopes (`mcp:read`, `mcp:write`, `mcp:execute`, `mcp:trade`, `mcp:payments`, `mcp:admin`), one scope per tool, `executeWithPermissionGate` authorizing before execution with sealed-execution isolation. The defaults are permissive by the SCOPED DEFAULTS rule: `system`, `session`, `api-key`, and `agent-turn` principals hold every scope; `scanner-payment` holds only `mcp:payments`; `unknown` holds nothing. The IAAA role→scope adapter is an explicitly future seam.
- **Agents:** `src/security/agentAccess.ts` (#2171) decides permission-bearing grants through the PDP seam (`createAgentPdpChecker` over `iaaaPdpSeam.ts`); delegations are re-checked at every invocation; obligations evaluation is opt-in; audit is a condition of allow. `ExecutionContext` (#1078) is the one validated context contract across APIs, jobs, agents, and tools (PDP decision embedded, frozen, revalidated at boundaries, delegation narrows-never-widens) — with live wiring deliberately staged. The system-principal gap (G-AUD-3) is explicitly open.
- **One-model rule** (owner, 2026-11-18): hardening conforms to ONE security model — no new, parallel, same, or duplicate mechanism. The route→role registry idea, proposed in the parity inventory as an optional new mechanism, is REJECTED by the owner; the default is to extend `commercialUrlCatalog` instead.

### 6.3 Known holes (live, stated plainly)

1. **G-1 — ledger write-through routes.** The three HTTP write-through routes in `src/agents/routes/agenticPayments.ts` — `POST .../ledger/record` (:508), `record-cfpay` (:610), `record-native` (:682) — contain NO handler authorization check and trust body `userId`/`tenantId`/`priceUSD`. The dispatcher blocks anonymous callers (a session is required), so the exposure is any *signed-in* user posting ledger rows naming another user. Their only legitimate callers are server-side (the payment workflow and ledger helpers calling the Durable Object directly with the configured service identity; no page or user flow calls them). `record-native` has no production HTTP caller at all — the workflow calls the native port directly. In-handler ledger writes (purchase/confirm/submit handlers writing journal projections and native ledger rows through ports inside already-gated handlers) are fine; the hole is only the external path through these three routes.
2. **Lifecycle preference tenant hole (G-4 part).** The lifecycle preference GET/POST (`agenticPayments.ts:8761–8814`) checks `canAccessAccount(login, userId)` only and uses the client-supplied `tenantId` as the store key unverified. Low-sensitivity data (digest/welcome preferences) but a real tenant-isolation violation of the session-scoping rule.
3. **Premium price bypass (G-7).** Premium prices are hardcoded constants (`TRADING_PAID_SERVICES`, `src/services/agenticPayments.ts`), bypassing the catalogue/approval/versioning model every other commercial surface uses. A premium price change today requires a code change.
4. **Legacy audit write (G-13).** `POST /audit` in legacy mode (the default) writes unvalidated audit rows; whether legacy is still the live default was not verified (runtime state). The strict validator already exists in-file; making strict the default is an owner decision (the legacy contract is test-pinned).

### 6.4 Enhancement direction (owner-decided, 2026-11-18)

- **Fix fully and holistically; no interim solution.** An interim dispatch-gate fix for G-1 was proposed, challenged by the owner (the service identity is documented for unattended work; the IAAA model must govern), and withdrawn. No interim ships. The G-1 hole stays open until the full fix lands, by the owner's explicit choice.
- **Reuse and enhance the existing IAAA model by closing its gaps**, as enhancement slices on the existing modules, CISO coordinated via issues (sequence around any in-flight CISO work, never collide): (1) wire the PDP `authorize()` into live route handlers through the existing seam; (2) add a money/ledger permission to the existing permission table with role bindings; (3) close the system-principal gap (G-AUD-3) per the existing `service:<login>` derivation; (4) plug the IAAA role→scope adapter into the MCP permission seam; (5) advance the staged `ExecutionContext` wiring for the commercial path. Missing pieces are CISO-owned (#945 follow-ups): CBO files them with the CISO lane and does not invent CISO-owned enforcement.
- **CDO's ORM and adapter approach** (owner, 2026-11-18): do not invent data-access solutions. Data access goes through ports in `src/data/*` with Drizzle D1 + in-memory adapters, `ormCatalogue.ts` as the single source for broker-table DDL, composition roots, and the migration runner (ADR 0002 port-first). Handlers must not touch the ORM directly; the CDO lane owns the data foundation. The ledger fix routes writes through the existing ledger ports.
- **API layer program:** design issue + ADR first, then slices, one PR each. The design defines the domain→module→API mapping (§5.4), the granularity policy (§5.5), the Hono migration sequence, the FOSS decision table, the JWT role definitions, and the standards×surface matrix (§6.5). The hardening batch (§7.2) folds into this program.

### 6.5 Standards, gateway, and framework decisions (owner, 2026-11-18)

- **Hono, fully.** The API layer is built on Hono — routing + middleware + ecosystem, not a shim over the hand-rolled dispatch. (Hono and itty-router were the evaluated FOSS routing candidates; Hono was decided.)
- **FOSS-first.** Use all best-fit FOSS pieces instead of custom solutions — custom code only where no best-fit FOSS piece exists, gap documented. Every library choice is judged on fit + recency + Workers performance, versions and rationale recorded. Guardrail: an existing working repo capability always wins over FOSS-new (no duplication). No auth framework (duplicates IAAA); no sidecar gateway (Kong/Envoy/Tyk/APISIX/KrakenD run as separate services and duplicate the edge). Validation reuses zod (already a dependency). The MCP SDK is already present.
- **JWT for stateless tokens.** Roles defined in the design: API tokens, service-to-service tokens, MCP access tokens. Sessions stay IAAA — JWT is not a second identity system. The JWT implementation (Hono's JWT middleware vs `jose`) is judged best-fit/fastest in the design.
- **All associated standards, across all surfaces.** JOSE (JWS/JWE/JWK/JWA, RFC 7515–7518), OAuth 2.1 + OpenID Connect, the JWT access-token profile (RFC 9068), PKCE, DPoP, mTLS binding, token introspection/revocation, PAR, rich authorization requests, token exchange, authorization-server + protected-resource metadata, JAR — for the best/secure payment solution across APIs, MCPs, agents, chat, UX, webhooks, jobs, and agent-to-agent calls. The design carries a standards×surface matrix; N/A only with a reason. OAuth 2.1 provider duties for external callers use Cloudflare's `workers-oauth-provider` (MIT, needs a KV namespace, reported consistency caveats) — the provider role only, never replacing IAAA login.
- **Cloudflare API Gateway (API Shield) schema validation on the free tier, with ports/adapters.** Verified from Cloudflare's docs: Free = 100 saved endpoints, 5 uploaded schemas, 200 KiB, Block only; JWT validation and discovery are Enterprise-only; mTLS with a Cloudflare-managed CA is on every plan. Configuration via API/Terraform in CI/CD, versioned in the repo. The design must confirm the limits in the dashboard (one third-party summary disagrees), prioritize endpoints (150 routes exceed the 100-endpoint limit — money paths first), split into at most 5 schemas, and stage validation before Block (Block-only means no log-first mode). Edge validation complements in-Worker IAAA enforcement; it never replaces it. The gateway is an edge adapter behind the repo's ports/adapters pattern: the OpenAPI spec is the shared contract driving both edge validation and in-Worker zod schemas.
- **Ports/adapters is the repo's own pattern** (ADR 0002), not a library feature: the gateway is a port with Worker + in-memory adapters; libraries plug in behind it.

## 7. AOP and ADD.md compliance

### 7.1 Verdict matrix (2026-11-18 assessment)

Groups: G1 commercial/agentic, G2 tenants, G3 accounts, G4 channels, G5 users, G6 payments, G7 premium, G8 meter, G9 assurance, G10 ads/referrals, G11 audit, G12 dispatcher. Full per-group evidence is in the compliance assessment (§10). "Not verified" marks code reads that could not settle the question; no runtime verification was done anywhere.

| Group | Exceptions | Coded messages | Logging | Config | Security | Transactions | ADD.md |
|---|---|---|---|---|---|---|---|
| G1 commercial | partial | partial | partial | compliant | partial | gap | partial |
| G2 tenants | gap | gap | gap | compliant | partial | gap | partial* |
| G3 accounts | partial | partial | partial | compliant | compliant | partial | partial* |
| G4 channels | gap | gap | gap | compliant | partial | gap | partial* |
| G5 users | compliant | gap | gap | compliant | compliant | compliant | partial |
| G6 payments | partial | partial | partial | compliant | partial | not verified | gap |
| G7 premium | not verified | gap | gap | gap | partial | not verified | partial |
| G8 meter | partial | gap | gap | compliant | compliant | compliant | compliant |
| G9 assurance | compliant | gap | partial | compliant | compliant | compliant | partial* |
| G10 ads/referrals | partial | gap | gap | partial | partial† | not verified† | gap |
| G11 audit | gap | partial | gap | partial | partial | compliant | gap |
| G12 dispatcher | — | — | — | — | compliant | — | gap |

(* = port-first compliant, API-first partial. † = caveated in the assessment.) Cross-cutting: configuration is the strongest aspect; logging + coded messages the weakest; **zero schema validation and zero multi-statement atomicity anywhere in scope.**

### 7.2 Ranked gaps G-1–G-15

One line each; file:line evidence and fix directions (every fix reuses an existing mechanism) are in the compliance assessment (§10). The hardening batch folds into the API-layer program (§6.4); the fix shapes below are the inventory's as assessed — where an owner decision since superseded a fix shape, the decision governs (§6.4, §8).

| Gap | Finding | Fix (reuse) |
|---|---|---|
| G-1 | Ledger write-throughs unauthenticated (§6.3) | Full IAAA-conformant fix per §6.4 (owner-decided; supersedes the inventory's in-file-gate suggestion) |
| G-2 | No multi-write atomicity anywhere; partial-apply risk (settings PATCH, bulk move, purchase flows) | D1 batch leg `d1BatchTransactionBackend` / `withTransaction`, today used by one adapter only |
| G-3 | Raw `err.message` returned to clients in G1/G2/G4/G6/G11 | G9 pattern (structured server-side log + generic coded response) |
| G-4 | No schema validation + lifecycle tenantId hole (§6.3) | One shared validation helper from the existing validators; verify lifecycle tenantId against resolved identity |
| G-5 | Zero or error-only logging in six files | #3515 module-logger seam |
| G-6 | Uncoded error literals across groups | Outcome catalog + `codedMessage` + in-file helpers; one catalog, never a second list |
| G-7 | Premium prices hardcoded (§6.3) | `getApprovedPrice` from the catalogue; owner decision on seeds |
| G-8 | No shared schemas / OpenAPI; platform paths duplicated as literals | Extend the `commercialUrlCatalog` pattern (route→role registry REJECTED, §6.2) |
| G-9 | Silent operator-list degrade (empty list on store failure) | Log + audit the degrade |
| G-10 | Route-layer ORM / `.db` shortcuts + the ~9,000-line handler | Existing ledger/marketplace/audit ports; `ensureSchema` into adapter factories; extract services |
| G-11 | Channel mutations unaudited + best-effort after-write audit | Wire the funnel; audit-before-write is an owner decision |
| G-12 | ADD.md names AOP without definitions | Doc-only AOP section reusing the real rule sources (§2) |
| G-13 | `POST /audit` legacy mode unvalidated (§6.3) | Verify the live default first; owner decision |
| G-14 | Audit pagination literals | Reuse `COMMERCIAL_DEFAULTS` |
| G-15 | Verification debt (G6/G7/G10 internals below the route layer) | Follow-up reads before relying on verdicts |

### 7.3 ADD.md state

ADD.md (153 lines) is a container doc only — it holds section structure and links and duplicates nothing. AOP appears exactly once, as one bullet in a standards list (ADD.md:111), with no definition. The enforceable rules live in the ADRs, [standards.md](../standards/standards.md), and the code itself (aspect modules in `src/aspects/`, the outcome catalog in `src/outcomes/`). Port-first (ADR 0002 R1: domain depends only on `src/data/*` ports) holds for the platform groups and the meter/assurance groups; the commercial handler is partial (route-layer ORM shortcuts, G-10); payments/ads/audit are gaps (direct store/ORM use in route code). Layering (routes → services → ports → adapters) is honored by no group fully. API-first holds at the path level (catalog) and is a gap at the schema level (no shared schemas, OpenAPI pilot-only, no versioning). The API/MCP architecture of record, [api-mcp.md](../application/api-mcp.md) (CPO lane), itself records gaps (monolithic ingress handler, OpenAPI drift, MCP error-format inconsistency, header-identity risk) — this doc does not re-state them.

## 8. Decisions log (owner decisions, dated)

All entries are owner decisions by Mars unless marked delegated. The most recent decisions govern where they change an earlier one.

| Date | Decision |
|---|---|
| 2026-10-27 | Full commercialization program (#2012, Goal 1 #2013, phases #2014–#2016), not one issue. First goal: monetize the screener for real users. All runs are scheduled runs behind the scenes. Multi-tenant, multi-user SaaS with tenant isolation. Monetization is a Flagship ON/OFF feature. Build the payment workflow deterministically — do not introduce a payment agent (PaymentsAgent already exists). |
| 2026-10-28 | All-native payments (umbrella #2146; the cfpay gate deprecated in place, ledger rows kept; cfpay A2A stays for Slack/Email). Minimal double-entry journal behind JournalPort, to be replaced by a real GL later. "Build whatever is remaining with defaults externalized" — defaults are operator-managed data with seeded proposed values, never code constants; missing data fails closed. Prices as proposed SEEDED catalogue defaults, not approval/activation. Audit-failure blocking mechanism (Q7) as a proposal slice; activation gated on CISO+CDO sign-off. |
| 2026-10-29 | Platform program #2218 (tenant/user/account scope; paid screens resolve tenant → user → account via platform APIs/ports without changing money behavior). SESSION SCOPED ALWAYS. First subscription purchase auto-creates the account server-side from verified session identity; pay-per-run submit with no account fails closed. |
| 2026-11-04 | #2012 canonical; #2405 stays open as the delivery plan. One implementation of everything — no duplicate implementations. |
| 2026-11-05 | Entitlements: triggered = on-demand user invocation of a scheduled run (tracked as user-involved); caps Free 10 / Basic 20 / Premium 30 per product per month, changeable; tiers cumulative; nothing over allowance; subscription prices approved ($0 / $49.99 / $59.99) with grandfathering; unlimited-free approver = tenant admin; grants and per-run approvals selective by platform/tenant admin. Always merge work into main via the queue; discuss after each PR go/no-go. Each user keeps their own subscription within a tenant. "There must be a UI for it" — no hardcoded defaults. |
| 2026-11-11 | Prices fully flexible operator data; annual figures are proposed seeds only. Referral rules all configurable from the UI per product. Free-for-lifetime YES, configurable/revocable, plus a free-for-a-limited-time variant. Upgrade-offer design delegated to CBO. |
| 2026-11-12 | #3246 design answers changed (standalone runs purchases; explicit operator rank; dismissal+cooldown in v1; PROPOSED shown unavailable; downgrades included; referral/free-access mentions). All three slices autonomous with debrief-after. |
| 2026-11-13 | "Get it done and open full PRs (not draft)". Gap issues: only #3178 stays open as the funnel-design tracker. COO handoff sent. |
| 2026-11-14 | "Complete all development/deployment first". BizCopilot: chat-first (not NLQ), umbrella #4514 + 8 sub-issues filed only. Ledger tabs directed. |
| 2026-11-15 | Discuss before BizCopilot slices 4–8. MCP tools via the LLM are the PRIMARY path through BizCopilot chat; deterministic branches stay as an option and are not removed. Conversion issues #4741–#4743 filed file-only. |
| 2026-11-16 | Full-stack issue template (#4914): architecture-first, R-7 full coverage default, FS sub-issues in the same motion as the parent (R-2). Issue form: "just a form and nothing else" — gates declined, retirement question closed. Code-first answers for UI questions; live authenticated checks only on explicit go-ahead. |
| 2026-11-17 | Daily review of AGENTS.md (corrected from gitops.md within a minute). Policy Gate check (l) landed (#5124): Reuse class + Dependencies on PR bodies and issues. |
| 2026-11-18 | Complete the lifecycle-doc refresh + the 28-issue audit; out-of-scope items get their own sub-issue; bring up anything needing a decision. Full chat/UX parity, discrete flows, simple first, quick wins by value. APIs/MCPs fully AOP-compliant and ADD.md-compliant, holistic, never duplicating an existing capability. ONE security model. Build the best-designed API layer (design + ADR first, then slices). 8 audit decisions delegated to CBO's recommendations. Follow CDO's ORM/adapter approach. Follow the IAAA model. Fix G-1 fully and holistically, NO interim solution; reuse and enhance the existing model by closing its gaps. Use API Shield schema validation on the free tier, with ports/adapters. Use Hono fully; best-fit latest/fastest FOSS libraries; JWT; all associated standards across all surfaces; FOSS-first. This integrated doc, kept here. |

**Delegated audit decisions (2026-11-18, owner delegated to CBO's recommendations; dispositions completed the same day, states verified by read-back 2026-11-18):** #2373 keeps the x402/MPP gate and stays OPEN awaiting the owner's VFY-1 live D1 read (spec posted on the issue); #3130 closed superseded (the template move was never built and contradicts the live form); #3243 closed with the trial-runs-lapse deviation accepted as built behavior and trial defaults as per-plan operator data with no build (issue amended); #3245 closed with the quota bound accepted as the grant's meaning (issue amended; the entitlements doc fix is on main, `46b6537d6`); #5291 closed won't-do, crypto stays non-refundable; #2202 stays closed with a decision comment, no dashboard retries, no reopen. #2373's VFY-1 spec is posted on the issue; the owner runs the check.

## 9. Open items

- **VFY-1** (owner-run): a live read of the F9 rows (live D1 read, specified from #4500's §15 report) confirming the premium price-model fix. #2373 closes when the read confirms F9. The VFY-1 spec text is not reproduced here — the issue carries it.
- **CISO dependencies** (filed with the CISO lane, never invented by CBO): the money/ledger PDP permission; the system-principal gap (G-AUD-3); PDP wiring into live routes; the MCP IAAA role→scope adapter; staged ExecutionContext wiring for the commercial path. Sequence around any in-flight CISO work; never collide.
- **Gated parity decisions:** §4.4 (Checkout capture scope, price approval, plaintext codes, refund execution, cfpay F75, bulk-move confirmation, non-operator MCP visibility, reconcile-or-deprecate F07/F51/F84, API-only F27/F28/F79/F86).
- **Price approval:** per-run prices remain PROPOSED; no live charge is verified; no real-user pilot has run. Native Stripe secrets, the x402 recipient address and network, and the CISO/CTO/COO post-merge reviews are outstanding. Merging code is not activation.
- **ADR 0026 discrepancy:** the ADR vs #2405 cfpay-decision discrepancy remains open for owner confirmation (recommendation: decline).
- **Premium unification (#2373):** the premium price model (hardcoded constants, G-7) vs the catalogue/approval/versioning model — unification is the design's job; VFY-1 is the owner's check.
- **Conformance points:** the chat paid path's raw catalogue read (§3.2); the $0-run failure-credit edge; the operator grant overwriting `tierSource` on operator-granted Subscribed accounts; the #3244 tierSource-overwrite edge; per-source trial clawback machinery (unbuilt); "triggered" as a distinct tracked trigger (unbuilt, unfiled).
- **Verification debt:** G-13's live default; G-15's below-route reads; the #4513 tenant-create hang cause (still undiagnosed — the timeout fix is hardening, not a root-cause fix); #2059's unevidenced live run.
- **Out-of-scope sub-issues filed 2026-11-18:** #5290 (journal recognition-schedule wiring), #5291 (crypto compensating payout — decided won't-do and closed, see §8), #5292–#5295 (#2208 residuals), #5296 (automate the PR-template checklist).

## 10. Evidence pointers and method limits

- **Evidence archive (survey copies, landed 2026-11-18 as `6bd76b710`, issue #5344):** `docs/architecture/survey/parity-inventory-2026-11-18.md` (flow inventory F01–F104, route inventory, domain mapping, composability analysis, §I hardening plan), `docs/architecture/survey/routes.md` (full 150-route table), `docs/architecture/survey/ux-actions.md` (134 UX action rows), `docs/architecture/survey/compliance.md` (AOP/ADD.md assessment, G-1–G-15 evidence), `docs/architecture/survey/cbo-audit-2026-11-18.md` (28-issue audit record). The survey copies are verbatim, including the wrong §G citations corrected in §2 above; the workspace originals (`~/workspace/cbo-parity/`, `~/workspace/cbo-audit-2026-11-18/`) are the same content.
- **Governing sibling docs:** [entitlements-01.md](entitlements-01.md), [platform-entity-capability-map.md](platform-entity-capability-map.md), [api-security.md](../security/api-security.md), [authn.md](../security/authn.md), [authz.md](../security/authz.md), [ADD.md](../ADD.md), [api-mcp.md](../application/api-mcp.md), [standards.md](../standards/standards.md).
- **Issue trackers:** parity #5306 (quick wins #5307–#5310, full-stack sub-issues #5311–#5342); BizCopilot #4514 (slices #4515–#4522, conversion #4741–#4743); programs #2012 (commercialization) and #2218 (platform management); audit decisions on #2373, #3130, #3243, #3245, #5291, #2202.
- **Method limits:** the inventories behind this doc are static code + issue-body reads. They do not establish runtime behavior, live state, deployed behavior, or signed-in UX behavior. Anything this doc states about the deployed app (URLs, gates, defaults) is a code-derived statement unless it names a live verification. Issue states are the 2026-11-18 audit snapshot; verify current state on GitHub before citing it.
- **Source conflicts:** two inventory sources disagreed on whether #3261 (profile email) is open or closed by other work; this doc states neither and the conflict is flagged in the filing record. Where the parity inventory's proposed fix shapes were superseded by owner decisions (§6.4), this doc states the decided direction and notes the supersession; the survey archive keeps the original text.
