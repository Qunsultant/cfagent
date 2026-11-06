# server.ts refactor by domain — Slice 1 contract (inventory only, no code move)

Issue: Qunsultant/cfagent#2902. Agent: #clo-arsi.
Separate cross-lane issue. NOT a sub-issue of Qunsultant/cfagent#2764.
Do not attach it to #2764, and do not change other lanes' domain logic
unilaterally; coordinate shared-file moves with the affected lanes
(options Qunsultant/cfagent#2621, trading, IAAA, payments) before moving
their routes, and do not merge a domain slice over a conflicting lane PR.

## 1. Baseline (verified, not assumed)

- File: `src/server.ts` on `origin/main`.
- Baseline commit at inventory time: `136e2293be24013f15cab091cee4325200d98f51`, rebased onto `cbf683585984d19eb2961d91fb8525c45ac2f32e` before submission.
- Size: **5,343 lines, 254,107 bytes** at `136e2293`; **5,308 lines, 252,882 bytes** at `cbf68358` (main advanced during Slice 1 with an ActorGateway dispatch refactor only — see note below).
- Shape, by line range on that baseline:
  - Imports and agent/DO exports: lines 1–360. Twenty re-exports
    (OrchestratorAgent, TickerAgent, OptionsScannerMCP, BrowserAgent,
    SlackAgent, AiSearchAgent, SandboxAgent, PaymentsAgent,
    ScheduledAgent, ScreenerAgent, ResearchAgent, TradingAgent,
    TradingTradeWorkflow, ScreenerScreenWorkflow, PaymentWorkflow,
    CrossDomainSagaWorkflow, ReportAssetAgent, SessionStore, plus
    `PREMIUM_GATEWAY_INSTANCE`).
  - Shared helpers: `isAllowedOrigin` (363), `handleNlqWebhookRequest`
    (407, Messaging — moves with Slice 7, not Core),
    `ensureBreakerDurability` (548), `handleFetch` (571–4761),
    `dispatchOptionsAnalysisQueueWork` (4762), default export
    (fetch / email / scheduled / queue, ~4827–5343),
    `requireAuth` (5259) and `authenticateRequest` (5269).
  - `handleFetch` prelude, in order: `ensureBreakerDurability`,
    static-asset serve, ingress throttle, public-REST burst cap for
    `/api/*`, then the domain branches in §3, then the `/api/*`
    fallthrough to the Orchestrator (SEARCH_AGENT) at 4462, then
    `/checkout/sandbox`, then `/` / `/index.html`, then static-asset
    fallback. **Branch order is part of the contract**: a later
    branch must never shadow an earlier one after a move, and the
    `/api/*` fallthrough must stay after every explicit `/api/*`
    branch, exactly as today.
- Two routers must not be confused:
  - `src/server.ts` (`handleFetch`, Worker entry) — this refactor.
  - `OrchestratorAgent.routeRequest` in `src/agents/orchestrator/*`
    — already a thin dispatcher, already pinned by
    `tests/thin_router_inventory.test.ts` (24 delegations, 200+
    route conditions, in `src/agents/routes/*.ts`). The `/api/*`
    fallthrough in `server.ts` forwards to that router; this
    refactor does **not** move, rename, or re-pin agent routes.
    Agent routes are therefore excluded from the §3 count below,
    except where a server.ts branch duplicates an agent route
    spelling (noted as alias where seen).

## 2. Thin-dispatcher contract (what "done" means)

After all slices, `src/server.ts` contains ONLY:

1. The default export: `fetch` (observability + error boundary
   around the dispatcher), `email`, `scheduled`, `queue` — each a
   one-line delegation to its domain consumer, plus
   `ensureBreakerDurability` where it is today (entry prelude).
2. The ordered router table: a sequence of
   `if (response) return response;` delegations to domain handlers,
   in the §3 order, with the `/api/*` Orchestrator fallthrough
   after all explicit `/api/*` domain branches, and the
   `/` / `/index.html` + static-asset fallback last.
3. No domain business logic, no inline route body, no
   per-domain import sprawl: domain modules import what they need;
   `server.ts` imports only the domain handlers and the shared
   auth/origin helpers it still needs for the prelude.
4. Agent/DO exports moved to a dedicated exports module
   (Cleanup slice), re-exported from `server.ts` only if wrangler
   binding requires the entrypoint export — if a binding does
   require it, that re-export is documented per class, not
   blanket-copied.
5. Shared helpers live once, not per domain:
   - `requireAuth` / `authenticateRequest` → shared auth helper
     module (Slice 2 Core), imported by every domain module that
     needs session auth. Never duplicated per domain.
   - `isAllowedOrigin` → same shared module (Core).
   - `ensureBreakerDurability` → Core prelude.
   - `handleNlqWebhookRequest` → Messaging slice (its only caller
     is the NLQ webhook branches).

### Proposed size pin (for review, not final until Slice 2 proves it)

- `src/server.ts`: **< 800 lines** (proposal, see evidence below).
  This number is taken from Qunsultant/cfagent#2902 as a starting
  proposal, not asserted as proven. Evidence for plausibility:
  a dispatcher needs roughly the default export (~30 lines),
  the fetch prelude (static + throttle + burst cap, ~60 lines),
  the router table (one delegation per §3 domain block, ~80
  lines), and the shared-helper imports — well under 800, with
  headroom for comments. It is ~15% of the current 5,343 lines.
- **Final number is approved in Slice 2**, when Core is actually
  extracted: if the real Core exceeds 800, Slice 2 must either
  split the router table into a named router module (and say so
  explicitly, with its own pin) or justify a revised number —
  it must not game the pin by moving dispatcher logic into an
  unpinned file. The pin is on `server.ts` itself; domain files
  are not size-pinned (the IAAA block alone is ~900 lines today),
  because pinning them would force artificial splits.
- Pin implementation (Slice 9 Cleanup, not Slice 1): a test that
  reads `src/server.ts` line count and fails above the approved
  number, plus the existing `thin_router_inventory` pin staying
  green (that pin covers the Orchestrator router, not this file,
  and must not be weakened to pass this refactor).

## 3. Route inventory (inline branches in handleFetch, baseline above)

Reading rule: a row is one top-level `path` branch in `handleFetch`.
Combined blocks (one `if` covering several paths, e.g. the IAAA
membership block, the telemetry block) are one row with all paths
listed — splitting them in a later slice must not change which
paths they cover, in which order, or their shared auth. Methods
are shown where the branch gates on them; otherwise the branch
handles the methods it handles today (see the code at the line
range, do not infer a method list from this table alone).
Auth column: `session` = `requireAuth` (401/403 as today);
`session-or-apikey` = session, else Bearer API key;
`public` = no session required in this branch;
`webhook` = signature / origin / service-identity check as today;
`inherited` = auth is applied by a shared outer block or by the
delegated handler, and the slice that moves it must pin it
exactly — this table does not guess it.

### Slice 2 — Core dispatcher (stays in / moves to core, not a domain)

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 606 | `/api/*` (public-REST burst cap, prelude only) | any | prelude |
| 617 | `/.well-known/oauth-client-id-metadata-document` | GET | public |
| 630 | `/a2a/*`, `/.well-known/*` → `handleA2A` | any | delegated |
| 636 | `/api/features` | GET | session-or-null (session optional) |
| 1290 | `/health`, `/api/health` | any | bearer/service (see code) |
| 4445 | `/openapi.json`, `/api/docs` | GET | session (401 otherwise) |
| 4462 | `/api/*` fallthrough → SEARCH_AGENT / Orchestrator | any | session, then delegated |
| 4548 | `/checkout/sandbox` | GET | public (KEEP PUBLIC, #2052) |
| 4620 | `/`, `/index.html` → landing / static fallback | GET | public |
| — | static-asset serve (prelude + fallback) | any | public |
| — | `fetch` / `email` / `scheduled` / `queue` entry wrappers | — | service-identity (scheduled/queue, #1185/#2331) |

### Slice 3 — Auth & IAAA

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 900 | `/login` | GET | public (redirects to provider) |
| 953 | `/auth/logout` | any | session cookie cleared |
| 972 | `/auth/etrade/start`, `/api/etrade/oauth/start` | any | session |
| 1010 | `/auth/etrade/callback` | any | session |
| 1025 | `/api/etrade/oauth/status` | any | session |
| 1035 | `/api/etrade/diagnostics` | any | session |
| 1088 | `/api/etrade/oauth/verifier` | POST | session |
| 1122 | `/api/etrade/oauth/renew` | POST | session |
| 1160 | `/api/etrade/oauth/revoke` | POST | session |
| 1176 | `/auth/public/start` | any | session |
| 1213 | `/auth/public/callback` | any | session |
| 1239 | `/api/public/status` | any | session |
| 1245 | `/api/public/connect` | POST | session |
| 1282 | `/api/public/disconnect` | POST | session |
| 1798 | `/api/me` | any | session |
| 1856 | `/api/iaaa/overview` | GET | session |
| 1905 | `/api/governance/seed-halt` | any | session (wired-session pattern) |
| 2654–2780 | `/api/iaaa/access-request`, `/api/iaaa/access-requests`, `/api/iaaa/access-request/decision` (one combined block, sub-branches by path/method) | GET/POST as today | session + wired-session / role checks |
| 2781–3529 | `/api/iaaa/memberships`, `/api/iaaa/membership/grant`, `/api/iaaa/membership/revoke`, `/api/iaaa/membership/edit`, `/api/iaaa/permission/deny`, `/api/iaaa/permission/clear`, `/api/iaaa/deactivate`, `/api/iaaa/offboard` (one combined lifecycle block, sub-branches by path/method) | GET/POST as today | session + wired-session / role checks |
| 3530 | `/api/api-keys` | GET/POST | session |
| 3563 | `/api/api-keys/*` | DELETE (and as today) | session + bearer |

### Slice 4 — Privacy & compliance

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 666–811 | `/api/privacy/status`, `/api/privacy/preferences`, `/api/privacy/export`, `/api/privacy/erasure` (one combined block, sub-branches by path) | as today | session, caller-own subject only |
| 1948 | `/api/chains/status` | any | session |
| 1987 | `/api/chains/reconcile` | any | session |
| 2032 | `/api/jobs/history` | any | session |
| 2075 | `/api/traces` | any | session |
| 2095 | `/api/agents/registry` | any | session |
| 2111 | `/api/products/catalog` | any | session |
| 2132 | `/api/jobs/reconcile` | any | session |
| 2193 | `/api/retention/purge` | any | session |
| 2461 | `/api/audit/history` | any | session |
| 2500 | `/api/reports/list` | any | session |
| 2541 | `/api/reports/seed-canonical` | any | session |

### Slice 5 — Trading & market

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 1466–1510 | `/api/schedule/*` (goals, operations, ticks) | GET/POST as today | session |
| — | `/api/payments/webhook`, `/payments/webhook` — moves with Platform & commerce (Slice 7), not Trading; listed there only | any | webhook |
| 3780 | `/api/trading/email/inbound` | POST | session (see code; email service) |
| 3802 | `/api/trading/email/approve` | GET | inherited (approval link) |
| 3840 | `/api/trading/slack/test` | POST | session |
| 3857 | `/api/trading/slack/link` | POST | session |
| 3891 | `/api/trading/voice/greeting`, `/api/trading/voice/turn` (voice/turn block) | GET/POST as today | session |
| 3922 | `/api/schedules` (forward to SEARCH_AGENT schedules) | any | session |
| 4030 | `/api/market/quotes/source`, `/api/market/quotes`, `/api/market-data/quotes`, `/api/foss/quotes` (quote-source block) | GET/POST | session |
| 4291 | `/trade/approve` | any | session |
| 4319 | `/clear`, `/reset`, `/api/clear`, `/api/reset` | any | session |
| 4341 | `/api/options/flows/*` (forward) | any | session |

### Slice 6 — Messaging & social

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 812 | `/api/saga/journey-gates`, `/api/saga/journey-decision` | any | session |
| 830 | `/api/saga/start`, `/api/saga/<id>/status` | any | session + origin check |
| 866 | `/nlq/webhook`, `/api/trading/nlq/webhook`, `/api/nlq/webhook` → `handleNlqWebhookRequest` (one handler, three spellings, byte-identical) | POST | webhook (HMAC, throttle, replay nonce) |
| 1321 | `/api/qa/investigate` | POST | session + bearer |
| 1361 | `/api/memory/search` | POST | session |
| 1545 | `/api/social/brief` | GET/POST | session |
| 1611 | `/api/social/approval`, `/api/social/approvals` | GET/POST as today | session |
| 1734 | `/api/social/posts` | GET | session |
| 1779 | `/api/social/token-health` | GET | session |
| 4098 | `/slack/commands`, `/slack/slash` | POST | webhook (Slack signature, in delegated handler) |
| 4118 | `/slack`, `/slack/events` | POST | webhook |
| 4149 | `/slack/interactions` | POST | webhook |
| 4249 | `/slack/install` | any | inherited |
| 4259 | `/slack/oauth_callback` | any | inherited |

### Slice 7 — Platform & commerce

| Lines | Path(s) | Method | Auth |
|---|---|---|---|
| 3586 | `/mcp`, `/api/mcp` | GET/POST/OPTIONS | session-or-apikey |
| 3627 | `/mcp/scanner`, `/mcp/scanner/*` | GET/POST/OPTIONS | inherited (scanner DO, see code) |
| 3678–3739 | `/api/premium/*`, `/api/payments/agentic/*`, `/payments/agentic/commercial/*` (OPTIONS preflight, then premium/agentic dispatch) | any | session |
| 3764 | `/api/payments/webhook`, `/payments/webhook` | any | webhook |
| 2286–2460 | `/api/telemetry/summary`, `/api/telemetry/decisions`, `/api/telemetry/decisions/<id>/(decide\|apply\|supersede\|expire)`, `/api/telemetry/reconcile` (one combined block) | as today | session |
| 2596 | `/api/retrieval/populate-market-graph` | any | session |
| 4046–4085 | `/api/browser/snapshot`, `/browser/snapshot`, `/api/browser/snap/transaction`, `/api/browser/transaction-snap`, `/trading/browser/transaction-snap` (browser snapshot block) | as today | session |

Note on Slice 7 vs Slice 5: the browser snapshot block is placed
in Platform here because it is a browser-agent platform surface,
not a trading order surface; if the Slice 5/7 owner disagrees,
the block moves as a whole with its line range and this table is
updated in the same PR — it must not be split across slices.

### Slice 8 — Queue / scheduled extraction

Not HTTP routes. Handlers in the default export and helpers:

- `email` → `handleCloudflareEmailMessage` (already delegated;
  stays as a one-line delegation, no move of the email service).
- `scheduled` (4838–4990): `*/30 * * * *` tick →
  ScheduledAgent `onCron`, plus unconditional dispatches that
  fire/no-fire inside the target route: research scheduled tick,
  reflection run, adaptation weights run, knowledge corpus sync,
  digest pass (#2659), retention, token renewal (03:00 UTC
  pass, identity-free enumeration). Service identity:
  `SERVICE_USER_LOGIN` + platform-tier provisioning gate
  (#1185, #2331) — fail closed, never a fabricated identity.
- `queue` (4991–5343): `screener-events-delivery`
  (screener.completed / screener.failed, per-subscriber dedup),
  `screener-events` (CloudEvents envelopes + legacy
  `options_analysis` taskType wrapper, deprecated, no new
  producers), and the options_analysis fallthrough, via
  `dispatchOptionsAnalysisQueueWork` (4762).
- Slice 8 moves each queue/scheduled consumer to its domain
  consumer module (screener-events → Messaging/Trading as
  appropriate, options_analysis → Trading), keeping the
  default-export wrappers one line each. Queue/scheduled
  behaviour (ack, DLQ, dedup, denied-message logging) must not
  change as a side effect.

### Baseline drift note (added at rebase)

Between the inventory scan (`136e2293`) and submission
(`cbf68358`), `server.ts` changed only by the ActorGateway
dispatch refactor (direct `SEARCH_AGENT.get(id).fetch` calls
replaced by `actorGateway.dispatch`/`actorGateway.stub`).
No `path` branch was added, removed, or renamed in that
diff, and no route method/auth changed. §3 line ranges below
are from the `136e2293` scan; they shift by up to ~35 lines
later in the file at `cbf68358`. Slice 2 must re-baseline
the exact ranges at move time and correct this table in the
same PR if any range is off — the path/method/auth list,
not the line numbers, is the contract.

### Count and reconciliation rule

- Inline top-level `path` branches counted in §3: **~84
  branch starts** (including combined blocks counted once),
  covering **138 unique path literals** found by a literal scan
  of `server.ts` (168 occurrences, including redirects and
  internal forward targets such as `https://agent.internal/*`,
  which are not routes and are excluded from the route count).
- The exact reconciliation is **not** this approximate count:
  Slice 2 must land a route pin (see §5) whose list is generated
  from the moved modules in order and must match the §3 list
  1:1, path by path, method by method. Any path that appears in
  the pin but not in §3, or vice versa, blocks that slice's PR
  until the table is corrected in the same PR with an issue
  reference for the route's origin.
- Delegated routes (the `/api/*` fallthrough to the Orchestrator,
  plus agent DO routes) are pinned separately by
  `thin_router_inventory` and are **not** double-counted here.

## 4. Target module layout (decision + why)

**Chosen: `src/server/routes/<domain>.ts`** — one file per domain
slice, e.g.:

- `src/server/routes/core.ts` (prelude helpers + router table
  helpers, if Core is split from `server.ts` itself)
- `src/server/routes/auth.ts`
- `src/server/routes/privacy.ts`
- `src/server/routes/trading.ts`
- `src/server/routes/messaging.ts`
- `src/server/routes/platform.ts`
- `src/server/routes/queue.ts` (queue/scheduled consumers)
- `src/server/auth.ts` (shared `requireAuth`,
  `authenticateRequest`, `isAllowedOrigin`)
- `src/server/exports.ts` (agent/DO exports, Cleanup)

**Why this layout, and why not the alternatives:**

- It matches the existing delegation precedent:
  `src/agents/routes/<handler>.ts` modules each export a
  `handleXRoutes(...)` that returns `Response | null`, and
  `OrchestratorAgent.routeRequest` calls them in order with
  `if (response) return response;`. Server domain modules use
  the same signature and the same ordered-delegation contract,
  so reviewers already know the pattern and the thin-router
  rule transfers directly.
- It matches the `src/data/*Route.ts` precedent (one route
  family per file, handler imported by the dispatcher) without
  colliding with it: `src/data/*Route.ts` files are
  single-route handlers for data ports; `src/server/routes/*`
  files are entry-level domain routers.
- **Not** `src/server/domains/<domain>.ts`: there is no
  `domains/` precedent in the repo, and it would read as a new
  domain-layer concept rather than what these files are —
  thin entry routers that delegate to existing handlers/ports.
- **Not** reusing `src/agents/routes/` for entry routes: agent
  routes are Durable Object routes (Orchestrator), with a
  different `env`/`ctx` shape and a different pin
  (`thin_router_inventory`). Mixing Worker-entry routes into
  that directory would break that pin's attribution and confuse
  which router owns which route.
- Each domain module imports only its own handlers/ports plus
  the shared `src/server/auth.ts`. No domain module imports
  another domain module. Circular imports are a hard failure
  for that slice's PR.

## 5. 1:1 route pin plan (implemented in Slice 2, specified here)

New test: `tests/server_route_inventory_2902.test.ts`
(implementation in Slice 2, not Slice 1 — Slice 1 is docs only).

The pin must assert, in order:

1. **Static inventory:** the ordered list of path conditions in
   `src/server.ts` + `src/server/routes/*.ts`, reconstructed by
   the same scan used for §3 (top-level `path` branches, in
   source order), equals the §3 list exactly. A route added
   without updating this pin fails; a route removed without
   updating §3 and the pin fails.
2. **Dispatch smoke:** for each §3 branch, a `worker.fetch`
   dispatch (the pattern already used by e.g.
   `tests/checkout_sandbox_xss_2052.test.ts`, importing the
   Worker default export) reaches the same handler outcome
   class as before the move — at minimum, unauthenticated
   public branches return their public response, and
   session-gated branches return 401 without a session.
   Full per-route behaviour is covered by the existing
   per-domain tests; this pin's job is "no route dropped,
   merged, or silently re-authed", not re-testing domain logic.
3. **Order pin:** the router table order in `server.ts` equals
   the §3 order. Reordering the table without a route-change
   issue fails.
4. **Thin-router pin stays green:** `thin_router_inventory`
   (Orchestrator) is run unchanged per slice; it must not be
   weakened, and any route it pins must not be double-moved.

## 6. Slice order and cross-lane coordination

1. Slice 1 — this contract (docs only, no code move).
2. Slice 2 — Core dispatcher + shared auth module + §5 pin.
   Core is the only slice allowed to change `server.ts`'s
   structure; later slices only remove a domain block and add
   a delegation line, in §3 order.
3. Slice 3 — Auth & IAAA.
4. Slice 4 — Privacy & compliance.
5. Slice 5 — Trading & market.
6. Slice 6 — Messaging & social.
7. Slice 7 — Platform & commerce.
8. Slice 8 — Queue / scheduled extraction.
9. Slice 9 — Cleanup: exports module, size pin (§2), §3
   reconciliation 1:1, thin-router pin green.

Per slice: own branch/PR, rebase onto fresh main,
`scripts/verify-before-merge.sh` green locally, PR body with
full Qunsultant/cfagent# references + `Process documentation
impact:` line, labels `auto-merge` + `lane:clo-arsi`,
`mergeable_state` clean, GitHub CI green, merge via merge
queue only, post-merge CI checked. Never merge over red,
never submit a PR while any check fails. If a domain slice
conflicts with an in-flight lane PR touching the same block,
pause that slice (do not force-merge over it) and record the
conflict on Qunsultant/cfagent#2902.

## 7. What Slice 1 deliberately does NOT decide

- The final size-pin number (proposal in §2, approved in Slice 2).
- Whether the browser snapshot block belongs to Platform or
  Trading (see §3 Slice 7 note — moves as a whole either way).
- Any behaviour, route, method, auth, or response-shape change:
  moves only. Any intentional change needs its own approved
  issue and must not ride along with a move.
- Any change to agent routes, trading/IAAA/payments domain
  logic, or stock programme scope (Qunsultant/cfagent#2764).

## 8. Open questions for review (do not guess in code)

1. Confirm the < 800-line pin in Slice 2 (see §2).
2. Confirm browser snapshot placement (Platform vs Trading).
3. Confirm that wrangler requires agent/DO exports from the
   entrypoint itself (if so, Cleanup keeps re-exports in
   `server.ts` with per-class justification; if not, they move
   fully to `src/server/exports.ts`).
4. Confirm the scheduled/queue consumer ownership split in
   Slice 8 (screener-events vs options_analysis) with the
   messaging/trading lanes before moving them.

## 9. Slice 2 re-baseline note (2026-11-05, PR for #2902 Slice 2)

- Baseline at Slice 2: `origin/main` `5627c72b`, `src/server.ts`
  **7,431 lines / 360,983 bytes** (was 5,343 at Slice 1). The §3 line
  ranges are the Slice 1 baseline (`136e2293`) ranges and are superseded
  as a locator by `tests/server_route_inventory_2902.test.ts`, which is
  now the live inventory; the §3 path/method/auth list stands, with the
  following re-baselined additions (no route changed, only recorded):
  the `/auth/login/<id>` + `/auth/callback/<id>` provider family,
  `/api/user/email-destination`, the WebSocket upgrade dispatch
  (`dispatchWsUpgrade`, after `/api/schedules`, before the quotes
  branches), the `/api/schedules` forward alongside `/api/schedule/*`,
  the full IAAA lifecycle block (role-grants, logged-in-users,
  quota-usage, policy-proposals, bootstrap-proposals sub-paths), and
  the method guards `POST|GET` (trading options), `GET|POST` (market
  quotes source), `OPTIONS` (premium/agentic preflight). Pin total:
  **148 ordered descriptors**, including the public-REST burst-cap
  prelude token and the static-asset fallback terminus.
- Resolved in Slice 2 (see also the pin test header): A2A /
  `.well-known` / `/api/features` are Core (contract §3 wins over the
  #2902 body; file order supports it); `/api/etrade/*` OAuth routes are
  Auth (Slice 3), not Trading. Q2 answered: browser-snapshot block is
  Platform (Slice 7), moved as a whole, never split.
- The <800-line pin (§2, open question 1) is **not set in Slice 2**:
  Slice 2 moves Core only and `server.ts` still holds every domain
  block (6,981 lines after Slice 2), so no pin Slice 2 could set is
  meetable. The proposal stands for review; Slice 9 sets the pin the
  slice actually achieves and never loosens a pin to fit.
- Q3 (entrypoint exports) is not re-decided in Slice 2: the in-code
  comments still state wrangler requires every bound DO class to be
  exported from the entrypoint; Slice 9 re-checks and keeps any
  required re-export with per-class justification.
- Q4 (scheduled/queue consumer ownership) stays open for Slice 8.

## 10. Slice 3 note (2026-11-05, PR for #2902 Slice 3)

- Baseline at Slice 3: `origin/main` `29e25b78` (Slice 2 merged),
  `src/server.ts` 6,981 lines / 338,401 bytes. Auth & IAAA move to
  `src/server/routes/auth.ts` (3,344 lines) as three handlers in dispatch
  order: `handleAuthLoginRoutes` (`/login`, `/auth/login/<id>`,
  `/auth/callback/<id>`, `/auth/logout`, E*TRADE + public OAuth families),
  `handleAuthMeRoutes` (`/api/me`, `/api/user/email-destination`,
  `/api/iaaa/overview`, `/api/governance/seed-halt`),
  `handleAuthIaaaRoutes` (access-request + full IAAA lifecycle +
  `/api/api-keys`). `loginProviderMatch` / `callbackProviderMatch` /
  `reqEnv` move inside `handleAuthLoginRoutes` with their branches.
  `src/server.ts` after Slice 3: 3,755 lines / 174,274 bytes.
- The 148-descriptor pin is unchanged (scanner reconstructs the identical
  ordered list before and after); the pin test's delegation-order assertion
  grows to the six delegations in dispatch order (Core early, Auth login,
  Core health, Auth me, Auth IAAA, Core late). No route changed.
- Pin updates in the same PR (repo pin rule): the D-D census pins in
  `tests/global_dd_census_2356.test.ts` move with the code — step 5b
  (session family: 20 list sites + 1 access-request site + 4 of 10
  membership-store sites to `auth.ts`, 6 membership-store sites remain in
  `server.ts`, totals unchanged) and step 5c (token family: the single
  `listTokenFamilyEntries` site to `auth.ts`); `tests/iaaa_legacy_pdp_bound_1749.test.ts`
  scans `server.ts` + `routes/auth.ts` for the same four PEP gates (each
  with its own explicit clock, grace-expired denial named), counts
  unchanged. Both files pass on clean main before the move and on the
  branch after the pin update.
- Q3 stays open for Slice 9; Q4 stays open for Slice 8. No new open
  question is raised by Slice 3.

## 11. Slice 4 note (2026-11-05, PR for #2902 Slice 4)

- Baseline at Slice 4: `origin/main` `57364bdb` (Slice 3 merged),
  `src/server.ts` 3,755 lines / 174,270 bytes. Privacy & compliance move
  to `src/server/routes/privacy.ts` (704 lines) as three handlers in
  dispatch order: `handlePrivacyRoutes` (`/api/privacy/status`,
  `/api/privacy/preferences`, `/api/privacy/export`,
  `/api/privacy/erasure`), `handlePrivacyChainsRoutes`
  (`/api/chains/status`, `/api/chains/reconcile`, `/api/jobs/history`,
  `/api/traces`, `/api/agents/registry`, `/api/products/catalog`,
  `/api/jobs/reconcile`, `/api/retention/purge`),
  `handlePrivacyReportsRoutes` (`/api/audit/history`,
  `/api/reports/list`, `/api/reports/seed-canonical`).
  `src/server.ts` after Slice 4: 3,144 lines / 150,320 bytes.
- The 148-descriptor pin is unchanged (scanner reconstructs the identical
  ordered list before and after); the pin test's delegation-order assertion
  grows to the nine delegations in dispatch order (Core early, Privacy,
  Auth login, Core health, Auth me, Privacy chains, Privacy reports, Auth
  IAAA, Core late), and its dispatch smoke gains a Slice 4 check that every
  moved route answers exactly as on clean main before the move (reads 401;
  chains/reconcile 500, jobs/reconcile, retention/purge and
  reports/seed-canonical 503 — unbound DO/AgentDB in the test harness,
  measured pre-move, not a move artifact). No route changed.
- Pin update in the same PR (repo pin rule): the D-D census pin in
  `tests/global_dd_census_2356.test.ts` step 5b moves 4 of the 6
  `wiredMembershipStore` sites from `server.ts` to `privacy.ts`
  (chains/reconcile, jobs/reconcile, retention/purge,
  reports/seed-canonical); 2 remain in `server.ts` (telemetry decisions,
  retrieval populate-market-graph — both Slice 7), totals unchanged.
  Two more source-presence pins read the entry surface as `server.ts` +
  `routes/privacy.ts` instead of `server.ts` alone (same PR, repo pin
  rule): `tests/data_foundation_slice4.test.ts` (four dashboard reads)
  and `tests/goal_chain_agentdb_modes_1729.test.ts` (audit/reports reads)
  — assertions unchanged, only the files scanned.
- Q3 stays open for Slice 9; Q4 stays open for Slice 8. No new open
  question is raised by Slice 4.

## 12. Slice 5 note (2026-11-05, PR for #2902 Slice 5)

- Baseline at Slice 5: `origin/main` `ab336f60` (Slice 4 merged),
  `src/server.ts` 3,144 lines / 150,320 bytes. Trading & market move
  to `src/server/routes/trading.ts` (559 lines) as four handlers in
  dispatch order: `handleTradingScheduleRoutes` (`/api/schedule/*`),
  `handleTradingOmniRoutes` (`/api/trading/email/*`,
  `/api/trading/slack/*`, `/api/trading/voice/*`,
  `/api/trading/options/*`, `/trading/options/*`, `/api/schedules`
  forward), `handleTradingQuotesRoutes` (`/api/market-data/quotes`,
  `/api/market/quotes`, `/api/foss/quotes`, `/api/market/quotes/source`),
  `handleTradingApproveRoutes` (`/trade/approve`, `/clear`, `/reset`,
  `/api/clear`, `/api/reset`, `/api/options/flows/*`).
  `src/server.ts` after Slice 5: 2,683 lines / 126,903 bytes.
- The 148-descriptor pin is unchanged (scanner reconstructs the identical
  ordered list before and after); the pin test's delegation-order assertion
  grows to the thirteen delegations in dispatch order (Core early, Privacy,
  Auth login, Core health, Trading schedule, Auth me, Privacy chains,
  Privacy reports, Auth IAAA, Trading omni, Trading quotes, Trading
  approve, Core late), and its dispatch smoke gains a Slice 5 check that
  every moved route answers exactly as on clean main before the move
  (most 401; batch quotes 200 — public by the #1725 M10 decision;
  `/api/trading/email/approve` 200; bare `/trade/approve` 400 on the
  missing orderId). No route changed; no options behaviour change — the
  `/api/options/flows/*` block moves as a whole.
- The WebSocket upgrade dispatch (`dispatchWsUpgrade`) stays inline in
  `server.ts` between the schedules forward and the quotes branches, in
  its original position: it is not a route branch (no path condition),
  the scanner does not see it, and the pin does not cover it. Slice 9
  decides its final home; it must not be split from that position
  without a recorded decision.
- Pin updates in the same PR (repo pin rule): the source-presence pins
  in `tests/options_flow_provenance.test.ts` read the entry surface as
  `server.ts` + `routes/trading.ts` instead of `server.ts` alone
  (assertions unchanged, only the files scanned); the same entry-surface
  change applies to the #154 source pins in
  `tests/fallback_identity_session_gate.test.ts` (401-guard count and
  fallback-identity absence), the #149 source pin in
  `tests/trade_approve_session_gate.test.ts` (approve-route session
  gate), and the #3121 S1 source pin in
  `tests/schedule-3121-s1-parity.test.ts` (goal-funnel audit wiring).
- Rebase note: the branch was rebased onto main `5d0db98c`, whose #3121
  S1 commit had added goal-lifecycle audit wiring
  (`auditGoalLifecycle`, creation provenance, four
  `schedule.goal.*` audit calls) inside the schedule block after Slice
  5's extraction base. The conflict was resolved by keeping the Slice
  5 move and porting the #3121 S1 changes verbatim into
  `handleTradingScheduleRoutes` in `routes/trading.ts` (with the
  `consolidatedScheduling`, `DoStubLike`, and
  `SHARED_ORCHESTRATOR_INSTANCE` imports); no #3121 behaviour was
  dropped or changed. Final sizes are measured after the rebase and
  recorded in the PR body.
- Q3 stays open for Slice 9; Q4 stays open for Slice 8. No new open
  question is raised by Slice 5.

## 13. Slice 6 note (2026-11-05, PR for #2902 Slice 6)

- Baseline at Slice 6: `origin/main` `08159218` (Slice 5 merged),
  `src/server.ts` 2,683 lines / 126,903 bytes. Messaging & social move
  to `src/server/routes/messaging.ts` (913 lines) as three handlers in
  dispatch order: `handleMessagingSagaRoutes` (`/api/saga/*`, the three
  NLQ webhook spellings, `/api/qa/investigate`, `/api/memory/search`),
  `handleMessagingSocialRoutes` (`/api/social/*`),
  `handleMessagingSlackRoutes` (`/slack/*`). `handleNlqWebhookRequest`
  and `NLQ_WEBHOOK_SERVICE_LOGIN` move with this slice (contract §2.5:
  the NLQ branches are their only caller). The saga handler takes the
  handleFetch ingress `throttle`, which the NLQ branch passes to
  `handleNlqWebhookRequest`.
  `src/server.ts` after Slice 6: 1,866 lines.
- The 148-descriptor pin is unchanged (the scanner reconstructs the
  identical ordered list before and after). Two scanner/pin facts this
  slice: the AuthLogin/CoreHealth delegations sat between the NLQ and
  QA branches inside the moved saga region, so they now run nested
  inside `handleMessagingSagaRoutes`, in the same position — they no
  longer appear in server.ts's own delegation list (fourteen entries
  now), and the pin test's `scanFunction` now follows nested
  route-module delegations (seen-set against cycles/duplicates) so the
  reconstruction stays 1:1. Delegations to handlers outside
  `src/server/routes/*` (e.g. the saga agent-route handlers) are
  implementations, not route branches, and are ignored. The pin test's
  dispatch smoke gains a Slice 6 check that every moved route answers
  exactly as on clean main before the move (session families 401; NLQ
  webhooks 503 on the unconfigured secret; Slack webhook routes 503 on
  the unconfigured signing secret; `/slack/install` and
  `/slack/oauth_callback` 500 in the harness).
- Pin updates in the same PR (repo pin rule): the source-presence pins
  in `tests/nlq_webhook_alias.test.ts`, `tests/slack_signature_gate.test.ts`
  (#147: mandatory gate on all three Slack routes),
  `tests/hybrid-retrieval-wiring.test.ts` (memory_search graph expansion),
  `tests/mcp_chat_nlq_routes_extraction.test.ts` (#313: single-owner
  NLQ handler), `tests/mesh_channels_s13_2412.test.ts` (#2412: Slack
  per-team forward, NLQ service identity), and
  `tests/mesh_conformance_s4_2339.test.ts` (#2339: chat forward via
  routeAgentRequest) read the entry surface as
  `server.ts` + `routes/messaging.ts` instead of `server.ts` alone
  (assertions unchanged, only the files scanned); the D-D census in
  `tests/global_dd_census_2356.test.ts` gains the new durableKv
  importer pair `["src/server/routes/messaging.ts",
  "../../data/durableKv"]` (the `DoNamespaceLike` import the moved
  SESSION_STORE casts need).
- Q3 stays open for Slice 9; Q4 stays open for Slice 8. No new open
  question is raised by Slice 6.

## 14. Slice 7 note (2026-11-05, PR for #2902 Slice 7)

- Baseline at Slice 7: `origin/main` `c5de0aaa` (Slice 6 merged),
  `src/server.ts` 1,866 lines / 88,828 bytes. Platform & commerce move
  to `src/server/routes/platform.ts` (596 lines) as five handlers in
  dispatch order: `handlePlatformTelemetryRoutes` (`/api/telemetry/*`),
  `handlePlatformRetrievalRoutes`
  (`POST /api/retrieval/populate-market-graph`),
  `handlePlatformMcpRoutes` (`/mcp`, `/api/mcp`, `/mcp/scanner`,
  `/mcp/scanner/*`), `handlePlatformPaymentsRoutes` (the OPTIONS
  preflight, `/api/payments/agentic/*` +
  `/payments/agentic/commercial/*`, `/api/premium/*`,
  `/api/payments/webhook` + `/payments/webhook`),
  `handlePlatformBrowserRoutes` (POST `/api/browser/snapshot`,
  `/browser/snapshot`, `/api/browser/transaction-snap`,
  `/browser/transaction-snap`, `/api/browser/snap/transaction`).
  The browser snapshot block is placed in Platform per the Q2 answer
  (contract §3 Slice 7 note; browser-agent platform surface, moved as
  a whole, never split). `src/server.ts` after Slice 7: 1,404 lines.
- The 148-descriptor pin is unchanged (the scanner reconstructs the
  identical ordered list before and after); the pin test's
  delegation-order assertion grows to the nineteen delegations in
  dispatch order, and its dispatch smoke gains a Slice 7 check that
  every moved route answers exactly as on clean main before the move
  (telemetry reads 401; telemetry reconcile/decide and retrieval
  populate 503 on the unbound AgentDB; MCP OPTIONS preflights 200;
  `/mcp` and `/api/mcp` 401; scanner and premium/webhook forwards 500
  on the unbound DO stub in the harness; browser snapshots 401).
- `PREMIUM_GATEWAY_INSTANCE` moves with the payments handler (its only
  use in the entry): defined in `routes/platform.ts`, re-exported from
  `src/server.ts` at its old position so the existing
  `import { PREMIUM_GATEWAY_INSTANCE } from "../src/server"` keeps
  working. The pin test's handleFetch end marker now matches that
  re-export line as well as the original definition.
- One comment annotation in the moved scanner block (not a code
  change): the DEPRECATED `x-user-id` alias line now names
  `x-scanner-session` as its successor — policy gate check (j)
  requires a deprecation marker to name what superseded it, and the
  comment already named `x-scanner-session` the honest header.
- Pin updates in the same PR (repo pin rule): the source-presence pins
  in `tests/mcp_api_key_transport.test.ts` (#180: MCP transport block),
  `tests/paid_screen_premium_2373.test.ts` (#2373: premium forward),
  and `tests/scanner_session_affinity.test.ts` (#700: CORS surfaces)
  read the entry surface as `server.ts` + `routes/platform.ts` instead
  of `server.ts` alone (assertions unchanged, only the files scanned);
  the same entry-surface change applies to the #2339 pins in
  `tests/mesh_conformance_s4_2339.test.ts` (per-login orchestrator
  dispatch; OptionsScannerMCP binding) and the #1733 R06 pin in
  `tests/rest_twins_modes_1733.test.ts` (transaction-snap identity
  fallback). The D-D census step 5b moves the last two
  `wiredMembershipStore` sites from `src/server.ts` to
  `src/server/routes/platform.ts` (telemetry decisions, retrieval
  populate-market-graph); the family total is unchanged.
  No durableKv census change: `routes/platform.ts` imports no durableKv
  symbol.
- Q2 is answered (browser snapshot is Platform, Slice 7, moved as a
  whole — recorded in §3 and in the Slice 7 progress comment on
  #2902). Q3 stays open for Slice 9; Q4 stays open for Slice 8. No new
  open question is raised by Slice 7.

## 15. Slice 8 note (2026-11-06, PR for #2902 Slice 8)

- Baseline at Slice 8: `origin/main` `452ae996` (Slice 7 merged),
  `src/server.ts` 1,404 lines / 67,183 bytes. Queue/scheduled
  consumers move to `src/server/routes/queue.ts` (793 lines): the
  module-level dedup sets (`screenerDeliverySeen`,
  `screenerEventsSeen`), the shared `dispatchOptionsAnalysisQueueWork`
  helper, and the default export's `scheduled`
  (`handleScheduledEvent`: every-30-minutes tick, 03:00 UTC token
  renewal, 04:00 UTC retention) and `queue` (`handleQueueBatch`:
  screener-events-delivery, screener-events, options_analysis
  fallthrough) handlers, verbatim. The default export keeps one-line
  delegations for `scheduled`/`queue`; `email` stays its one-line
  delegation. `src/server.ts` after Slice 8: 669 lines / 32,317 bytes.
- `ensureBreakerDurability` moves to `src/server/routes/core.ts`
  (contract §2.5 Core prelude) with its module state, so the entry's
  fetch handler and the queue/scheduled handlers can both call it
  without a server.ts cycle. No behaviour change: it is still called
  at the top of fetch, scheduled, and queue.
- The 148-descriptor pin is unchanged (queue/scheduled are not HTTP
  routes; the scanner does not see them); the pin test's
  delegation-order assertion is unchanged (nineteen delegations —
  scheduled/queue are default-export members, not handleFetch
  delegations). The pin test header records Slice 8 and the Q4 answer.
- Pin updates in the same PR (repo pin rule): the source-presence pins
  in `tests/kill_switch_verification.test.ts` (#756: weight-job
  callers), `tests/schedule-3121-s0-parity.test.ts` (S0-P01 cron
  dispatch, S0-P17 renewal / tick fan-out / provisioning gate), and
  `tests/stage_boundary_messages_2869.test.ts` (#2869: server queue
  routing) read the entry surface as `server.ts` +
  `routes/queue.ts` instead of `server.ts` alone (assertions
  unchanged, only the files scanned); the D-D census step 5e adds
  the `["src/server/routes/queue.ts", "../../data/durableKv"]`
  importer pair (the moved handlers' `DoStubLike` casts), so the
  family total grows by exactly that one pair.
- Q4 is answered (recorded here and in the Slice 8 start comment on
  #2902): the consumer wiring moves as one module `routes/queue.ts`,
  not split across messaging/trading route modules; ownership stays
  with the domain ports the wiring already calls — screener-events +
  screener-events-delivery → Messaging (QueuePort consumer, broadcast
  core), options_analysis dispatch → Trading's schedule surface,
  analysis-done / stage-boundary executors → owning ScreenerAgent DO,
  scheduled tick cross-domain by design. No lane acknowledgement was
  awaited (owner direction 2026-11-05 00:31 EST); the slice stops if
  a lane objects on the PR.
- Q3 stays open for Slice 9. No new open question is raised by
  Slice 8.
