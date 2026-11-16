# Survey — Issue #1169: R2 agent-search (real corpus, AI Search, fabricated fallback removed)

**Survey base:** main `f434a0cc` (verified via API at survey time), read-only worktree `~/workspace/w1169/wt` (clean).
**Issue:** #1169 (open, zero comments, no labels, signed `#CDO-mha7`, filed 2026-10-23). **No lane claim found.**
**Prior draft:** `~/workspace/wdata/R2-AGENT-SEARCH-ISSUE-DRAFT.md` is substantively identical to the filed issue body — not stale; the filed issue is authoritative and the draft adds nothing.
**Context doc:** https://docs.google.com/document/d/13ctAwiOllQO0MySdLHGP7mPVeDFBB6M_X5ccc9fKEqk/edit was **not read** — fetch failed with HTTP 401 (private doc). Not retried. All findings below are from code + the filed issue.

## Headline corrections to the filed framing (verify before building)

1. **The fabricated fallback's blast radius is narrower than the issue's framing suggests.** Only `ETradeAISearchService` falls back silently. MAS `searchKnowledge` does **not** use it and does **not** fall back — it returns honest errors when the upstream fails and no local reports exist (mas.ts:62-73, :105-113).
2. **A second hardcoded corpus exists that the issue does not name:** `searchPlatformKnowledge` (platform-capability docs) grounds MCP `knowledge_search` with hardcoded `score: 1.0` (commands.ts, platform-result mapping). Different class from the invented SEC snippets (real platform-doc content, hand-written), but the score is invented. Flagged as adjacent + decision gate — S3's scope per the issue is `FINANCIAL_KNOWLEDGE_BASE` only.
3. **The AI Search endpoint already exists and is configured** (wrangler.jsonc:112, hardcoded Cloudflare search URL). What it currently indexes is **not verifiable from code** — S2's first job is establishing that (owner dashboard + live probe) before adding the R2 `knowledge/` source.

## 1. Issues, lane claims, already-landed slices

- **#1169:** open, 0 comments, no labels, body signed `#CDO-mha7`. No lane claim, no owner direction, no slice landed.
- **#1168** (coordination target): open, 0 comments, body attributed `#CTO-mbshr`. Scope as written: sweep of `reports/*.json` objects in the `screener` bucket with no `mas_reports` row pointing at them; "do not build until [cross-instance key collection] is answered"; "no urgency". The `knowledge/` exclusion #1169 requires is **not recorded on #1168** (zero comments) — it must be recorded either on #1168 or in #1169's implementation, per #1169's Requirements.
- **Already landed since filing: none of #1169's slices.** Grep evidence at `f434a0cc`:
  - No `knowledge/` R2 prefix anywhere in src or wrangler (only a prompt string in chatPrompt.ts:51 and an E*TRADE URL in aiSearch.ts:47).
  - No AI Search binding, client, or index code (only raw `fetch` POSTs to `AI_SEARCH_ENDPOINT` — see §4).
  - `FINANCIAL_KNOWLEDGE_BASE` still present (aiSearch.ts:32) and still the fallback (aiSearch.ts:129-150).
  - No corpus ingestion code, no metadata schema, no corpus UI.

## 2. The current search stack (file:line)

### Surface A — MAS `searchKnowledge` (honest path, no fabricated fallback)

- `src/agents/mas.ts:21` — `searchKnowledge` tool (description: "Search the organization's knowledge base using Cloudflare AI Search RAG…"), exported at mas.ts:396, aliased as `knowledge_search` in `src/agents/mcpAdapter.ts:59`.
- Flow (mas.ts:28-116): TTL cache check (`getAiSearchCache`, key `aisearch:<session>:<k>:<query>`) → local `mas_reports` search first (`searchScheduledReports(sql, query, 5)`, mas.ts:38-45) → `POST ${env.AI_SEARCH_ENDPOINT}/search` with a 10s abort timeout (mas.ts:49-54).
- Upstream non-OK + local reports: returns the reports honestly with a message saying the upstream was unavailable (mas.ts:62-73); the error result is NOT cached.
- Upstream non-OK + zero reports: returns `{ error, query }` (mas.ts:74) — honest failure, no stubs.
- Upstream exception + zero reports: returns `{ error, query, resultsFound: false, count: 0, chunks: [] }` (mas.ts:105-113).
- Upstream success: merges report chunks + AI Search chunks, caches only successful results (mas.ts:75-98).
- Zero-chunk success message tells the model to "Synthesize a helpful, authoritative response from general knowledge, clearly informing the user that no specific internal documents were indexed" (mas.ts:90) — labelled synthesis instruction, not presented results; wording note for S4, not a fabrication.
- Tool input: `query` string, min 1 / max 500 chars (mas.ts:24-26).

### Surface B — MCP `ai_search_financial_docs` (THE fabricated fallback)

- `src/mcp/cloudflareAgentCommands.ts:223` — `AISearchFinancialDocsCommand`, name `ai_search_financial_docs`, registered at `src/mcp/commands.ts:1037`. Its `execute` (cloudflareAgentCommands.ts:239-244) constructs `ETradeAISearchService(context.env)` and returns `searchFinancialDocs` verbatim, auditing only the match count.
- `src/services/aiSearch.ts` — `ETradeAISearchService.searchFinancialDocs(query, limit = 5)`:
  - Primary (aiSearch.ts:105-127): if `env.AI_SEARCH_ENDPOINT` is set, POST with `messages + ai_search_options.retrieval.max_num_results (min(limit, 10))`; on `resp.ok` + `json.success` + `json.result.chunks`, maps chunks to `AISearchResultItem` with `provider: "cloudflare_ai_search"`. Note the mapping defects the build should know: every upstream result is forced to `category: "sec_filing"` regardless of source, and missing scores default to `0.9` (aiSearch.ts:119-124).
  - Fallback (aiSearch.ts:129-150): on **any** failure — endpoint unset, non-OK response, malformed JSON, thrown fetch — it silently keyword-matches the hardcoded base and returns the top `limit` with `provider: "semantic_cache"`. No degraded flag, no error, no indication the results are stubs. Scoring: `matchCount / terms.length`, floored at `doc.score * 0.4` when nothing matches (aiSearch.ts:136) — so even a zero-term-match query returns stub rows with scores ≥ 0.34.
- `FINANCIAL_KNOWLEDGE_BASE` (aiSearch.ts:32-95): exactly 5 hand-written entries with invented scores — `sec_nvda_10k_2025` 0.95, `etrade_order_types_guide` 0.92, `finra_rule_4210_pdt` 0.89, `options_clearing_corp_odg` 0.88, `sec_aapl_10q_services` 0.85 — categories `sec_filing` / `broker_rules` / `options_disclosure` / `market_education` (the type declares 4 categories; the base uses 3, no `market_education` entry). URLs are external (sec.gov, finra.org, theocc.com, us.etrade.com) — no served-file link exists.
- **Only production consumer of `ETradeAISearchService`:** the MCP command above. Grep confirms no other src caller of `ETradeAISearchService` or `searchFinancialDocs`.

### Surface C — MCP `knowledge_search` (platform grounding, second hardcoded corpus)

- `src/mcp/commands.ts:62` — `KnowledgeSearchCommand`, name `knowledge_search`. Flow: same `AI_SEARCH_ENDPOINT` POST (10s timeout); if zero chunks **or** the query matches the platform-query regex (platform/capability/workflow/screener/options flow/builder/payoff/hitl/guardrail/etrade/did/schedule/cron/nlq/how-to/pickbesttrades/faq), it grounds with `searchPlatformKnowledge(query, { maxResults: 3 })` from `src/services/platformKnowledge.ts` and returns those results with hardcoded `score: 1.0` and a message naming "the internal Platform Knowledge Base".
- `platformKnowledge.ts` content: structured platform-capability graph (8 workflows, 8 FAQs, 6 decisioning engines, chat/UI instructions) sourced from `src/client/workflowsFaqData.ts`, with a live strategy-catalog count derived from the server registry. Content is real platform documentation, hand-written — but the 1.0 scores are invented, and the results are presented as search results. **Decision gate (see §7):** does S3's no-invented-scores rule cover these 1.0 scores, or is platform grounding out of S3's scope? The issue does not name it. The build must not silently expand scope either way.

### Cache — `src/services/aiSearchCache.ts` (single owner, #278)

- TTL 5 minutes (`AI_SEARCH_CACHE_DEFAULT_TTL_MS`), capacity 200 entries oldest-first (`AI_SEARCH_CACHE_DEFAULT_MAX_ENTRIES`), env-overridable via `AI_SEARCH_CACHE_TTL_MS` / `AI_SEARCH_CACHE_MAX_ENTRIES` (aiSearchCache.ts:20-54).
- Key: `aisearch:<scope>:<k>:<query>` — normalized query + caller scope (session/user login), topK clamped 1..50 (aiSearchCache.ts:62-68).
- Isolate memory only — NOT shared across isolates, NOT durable, gone on eviction/restart; only successful upstream results cached, errors never cached (header honesty note, aiSearchCache.ts:8-18).
- Consumers per the header: mas.ts `searchKnowledge` and `src/agents/search.ts` `SearchAgent` — **but `src/agents/search.ts` does not exist** at `f434a0cc` (stale doc reference; grep confirms no such file). Only mas.ts actually imports it.
- Shared-cache caveat: config comes from the first env seen (aiSearchCache.ts:121-127).

## 3. Corpus state: nothing exists

- **Bucket:** `REPORTS_BUCKET` → bucket name `screener` (wrangler.jsonc:21). No second bucket; S1 reuses this binding per the issue.
- **Key families** (`src/services/reportBlobStore.ts`, `r2KeyForStorageKey`): `screener:*` → `stocks/…`, `options:*` → `options/…`, `goal_screen:*` → `goals/…` (added #1335); keys outside those families pass through unchanged. **`knowledge/` is not declared anywhere.** S1 may write `knowledge/` keys directly (pass-through) but should declare a `knowledge:` family for consistency — a small decision for the S1 build, not an assumption.
- **Blob metadata precedent** (`reportBlobStore.ts`, `putReportPdf`): `httpMetadata.contentType` + `customMetadata.fileName`, plus a DO-storage meta record (`fileName`, `r2Key`, `storedAt`). S1's metadata (title, category, source URL, ingested-at, content hash) has no schema yet — the build defines it.
- **Ingestion:** no ingestion path exists — no admin/API upload for corpus files, no repo-sync, no hash-idempotent writer. The issue references "the requester's R2 sync/prune Actions draft" from the context doc (unread, 401) — the S1 build cannot rely on it; it must define the ingestion path itself (API upload and/or repo-sync) and record the choice in the issue.
- **Serving precedent:** `GET /screener/report.pdf` (`src/agents/routes/screenerResearch.ts:118`) resolves the agent by `x-user-login` header or session context and streams bytes with `Content-Type` / `Content-Disposition` / `Content-Length` — the pattern S2's authenticated corpus-file route mirrors (session-scoped, never public bucket access).

## 4. AI Search state: endpoint configured, no index code, no R2 wiring

- **Endpoint var:** `AI_SEARCH_ENDPOINT = "https://f57a6011-bc38-4d64-856d-69ad4c90042a.search.ai.cloudflare.com"` (wrangler.jsonc:112). Both mas.ts and commands.ts POST `{ messages: [{ role: "user", content: query }] }` to `${endpoint}/search`.
- **No `ai_search` binding in wrangler.jsonc** (only `"ai": { "binding": "AI" }` at :22 and `"vectorize": [{ "binding": "VECTOR_MEMORY", "index_name": "vector-memory" }]` at :105-110, "PR #6 — Vectorize for VectorMemory").
- **No R2→AI-Search wiring:** no workers, queues, or ingestion triggers connecting the `screener` bucket to any index. No index-creation, document-upload, or index-query client code for a corpus index.
- **What the instance indexes today is unverifiable from code.** The only evidence: `src/agents/orchestrator/reportDispatch.ts` (persistScreenerReportCanonical, #308) calls `mas_reports` "the store the AI Search read path queries (issue #307)" — i.e., the read path queries `mas_reports` (the same local table mas.ts searches directly). Whether the Cloudflare instance itself indexes reports, nothing, or something else cannot be determined from the repo — **S2 must establish it by owner-dashboard inspection + a live probe** (a query that should hit a known report, and a query that should miss) before adding the R2 source. This is S2's first task, not an afterthought.
- **Adjacent prior art (reuse candidate, not the same index):** `src/services/reportSemanticIndex.ts` (#337) — semantic report indexing: Workers AI embeddings (`@cf/baai/bge-base-en-v1.5`) into the shared `VECTOR_MEMORY` Vectorize index keyed by report id, best-effort (indexing never fails storage; search degrades to lexical-only when AI/Vectorize bindings are absent). S2's specified path is Cloudflare AI Search over the R2 source, not Vectorize — the build reuses its *patterns* (best-effort indexing, graceful degradation, metadata discipline), not its index.
- **Owner dashboard steps (cannot be verified from code — do not claim done or undone):** AI Search instance provisioning (if the instance behind the endpoint URL is not already provisioned for this purpose), configuring the R2 `knowledge/` source on that instance, and confirming its current sources. Until those exist, all search surfaces must degrade honestly (the mas.ts path already does; the MCP financial-docs path does not — that is S3's job).

## 5. Consumers and what each does with a fallback result today

| Consumer | File:line | Fallback behavior today |
|---|---|---|
| MAS `searchKnowledge` (chat agent toolset via `createMAS`, used by `src/agents/orchestrator.ts:34`) | mas.ts:21, :396 | No fallback. Honest error or local reports only (§2A). |
| MCP `knowledge_search` | commands.ts:62 | Platform grounding when zero chunks or platform query — results labelled "internal Platform Knowledge Base", scores hardcoded 1.0 (§2C). |
| MCP `ai_search_financial_docs` | cloudflareAgentCommands.ts:223, registered commands.ts:1037 | **Silent stub results** with `provider: "semantic_cache"` and invented scores; the MCP client/LLM sees them as results. No degraded flag reaches any UX (§2B). |
| Chat RAG grounding | via MAS toolset (no direct `searchKnowledge`/`ETradeAISearchService` call in chat files found) | Inherits mas.ts behavior (honest). The zero-chunk message instructs synthesis "clearly informing the user that no specific internal documents were indexed" (mas.ts:90). |
| NLQ paths | no direct search calls found in `src/agents/nlq/` or `src/services/nlq*` | Reaches search only via MAS tools (same honest behavior). If NLQ is later found to call an MCP search tool directly, that path inherits that tool's behavior — the S4 build verifies this. |
| Research UI | no corpus consumer (see §6) | N/A today. |

## 6. UI surface: no corpus UI exists

- Research-area surfaces today: `ReportsPanel.tsx` (reports), `FossResearchHub.tsx`, `OptionsResearchPanel.tsx`, `ResearchReportActions.tsx`, `researchReports.ts` — all report/research-run surfaces, none listing corpus files or search state.
- **S4 must add:** a Research-area surface listing corpus files (title, category, source URL, ingested-at, bucket key) + search state (live index connected: yes/no, last sync/indexing state) + degraded-state display when the corpus/index is unavailable. Per standing requirements the surface is also schedulable (corpus sync/reindex) with downloadable result export — the S4 build states how (scheduled sync job + export of the corpus listing / result set) or records an explicit tracked deferral.
- Served-file links: S2's authenticated file route (§3) is what citations open — not the external URLs the stub base carries today.

## 7. Sequencing, S3 proof bar, overlaps, decision gates

### S3 proof bar (exact — all must hold before the fallback goes)

1. A live query via **both** `searchKnowledge` **and** `ai_search_financial_docs` against the indexed `knowledge/` corpus returns ≥1 result carrying bucket-key provenance (bucket key, title, category, index score — never invented) **and** a served-file link.
2. The served-file link returns the **exact bytes stored in R2** (hash-verified in tests, per the issue's acceptance criteria).
3. With the AI Search instance unconfigured, **both** surfaces return the degraded state in the API response (error/degraded field, zero stub results in production mode) **and** the UI displays it.
4. Pin test: no `FINANCIAL_KNOWLEDGE_BASE` matches in served results (production mode).
5. Only then: delete the constant + the fallback branch (aiSearch.ts:32-95, :129-150), or retain it **only** behind an explicit demo flag with visible demo labelling (issue's S3 alternative — the build states which, and pins the labelling if retained).

### Order

S1 (corpus + ingestion + metadata, hash-idempotent) → S2 (instance source + serving + primary-path query) → S3 (fallback removal, only on the proof bar above) → S4 (consumers carry provenance + UI). Each slice its own PR under gitops. S3 must never precede S2 live proof — otherwise search goes dark silently instead of honestly labelled (issue's Rollout).

### Overlap with in-flight work: none found

Search-stack files (`src/services/aiSearch.ts`, `aiSearchCache.ts`, `platformKnowledge.ts`, `reportSemanticIndex.ts`; `src/agents/mas.ts`, `mcpAdapter.ts`; `src/mcp/commands.ts`, `cloudflareAgentCommands.ts`) do **not** intersect #1331's files (yahooHistory migration), #1356's files (screener liveDeps/screenerPipeline), or the provider-platform slices (adapters.ts, routes/dataProviders.ts). One shared *concern*, not a file overlap: the `screener` bucket's key namespace (S1's `knowledge/` family vs #1168's sweep scope) and the provenance conventions shared with #1116.

### Decision gates (for the parent — nothing invented)

- **G1 — platformKnowledge 1.0 scores:** in or out of S3's no-invented-scores rule? (Issue is silent; §2C.)
- **G2 — S2 index technology:** Cloudflare AI Search over the R2 source (issue-specified) vs extending the existing Vectorize pattern (#337)? The issue specifies AI Search; a Vectorize pivot needs owner direction.
- **G3 — S1 key family:** declare a `knowledge:` namespace in `r2KeyForStorageKey` (consistent with stocks//options//goals/) or write `knowledge/` keys directly (pass-through)? Recommend the namespace declaration.
- **G4 — ingestion path:** admin/API upload vs repo-sync vs both? The issue allows either; the context doc's Actions draft is unread (401) and cannot be relied on.
- **G5 — S1 seed corpus:** which real documents seed the corpus (the 4 categories the result type declares: SEC filings, broker rules, options disclosures, market education)? The 5 stub entries' *topics* may guide selection, but their *text* must not be copied as corpus content — it is hand-written stub text, not source documents.
- **G6 — demo-flag alternative:** if the stub is retained anywhere behind a demo flag, the flag name, the visible labelling, and the labelling pins must be specified before S3 lands.

## 8. Test surface

**Existing coverage (regression surface for the build):**

- `tests/mcp.test.ts` — general MCP coverage; **does not cover `ai_search_financial_docs` at all** (zero matches for ai_search/financial_docs/searchFinancialDocs).
- `tests/report-semantic-index.test.ts` — #337 Vectorize report indexing.
- `tests/platform_knowledge_chat.test.ts` — platform-knowledge chat grounding.
- `tests/orchestrator-prompt-fixtures.ts`, `tests/patterns_solid.test.ts`, `tests/think-orchestrator-parity.test.ts` — reference search bits (prompt fixtures / parity, not search behavior pins).
- `tests/mas-data-retention.test.ts`, `tests/orm-mas-reports-migration.test.ts`, `tests/scheduled_failure_semantics.test.ts` — adjacent (retention/migration/failure semantics).
- **Zero test files reference `semantic_cache`, `FINANCIAL_KNOWLEDGE_BASE`, `searchFinancialDocs`, or `ai_search_financial_docs`.** The fabricated fallback is entirely unpinned today — the S3 build's first pins (fallback-honesty pins) will be new coverage, not adaptations.

**New pin files the build should add (per slice):**

- S1: `tests/r2_knowledge_corpus_p1169.test.ts` — ingestion idempotency (same content hash → same key, no duplicate), metadata completeness (title/category/source URL/ingested-at/hash), `knowledge/` key-family mapping, per-tenant auth gates on read/write.
- S2: `tests/r2_knowledge_serving_p1169.test.ts` — served-bytes hash equality with R2 bytes, served-file link resolution from result provenance, index-query mapping (upstream chunk → result item with index score, no forced category, no defaulted score).
- S3: `tests/r2_knowledge_honesty_p1169.test.ts` — index-unconfigured → degraded state on both surfaces, zero stub results in production mode, no `FINANCIAL_KNOWLEDGE_BASE` matches in served results (grep pin), demo-flag labelling pins if retained.
- S4: `tests/r2_knowledge_consumers_p1169.test.ts` — provenance propagation through `searchKnowledge` and `ai_search_financial_docs` (bucket key + title citations in answers), UI state rendering (connected/degraded/indexing), scheduled sync + downloadable export (or the tracked deferral).

## Residuals (named, not absorbed)

- `src/agents/search.ts` referenced by the aiSearchCache header but nonexistent — stale doc reference; the S1–S4 builds fix the header or leave it, but do not build on the assumption that a second search agent exists.
- `searchPlatformKnowledge` score 1.0 (§2C, gate G1).
- The zero-chunk synthesis message wording (mas.ts:90) — honest as labelled, but S4 should confirm the UX renders the "no specific internal documents" qualifier rather than letting the model elide it.
- NLQ's exact search path (no direct calls found; S4 verifies whether NLQ reaches search only via MAS tools).
- #1168's cross-instance key-collection design question (open, CTO) — S1 only needs the `knowledge/` exclusion recorded, not #1168 solved.
- The AI Search instance's current indexed sources (unverifiable from code — S2 establishes by dashboard + live probe).
