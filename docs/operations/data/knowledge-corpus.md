# Knowledge corpus and AI Search serving

**Status:** As-built + in-flight · 2026-11-06 · Traces to #1169,
#2246, #3321, #3322, #3323, #3342, #3345, #3375, #3525 · #CDO-mha7

The corpus is the platform's curated reference library — regulator
and industry documents (margin rules, the options disclosure
document, order-type education) that AI surfaces cite instead of
paraphrasing from memory. Its value is provenance: every served
answer traces to a document whose bytes are hash-verified.

## The corpus model

- **Seed manifest** — `docs/knowledge-corpus-seed-manifest.json` is
  the registry of expected documents: title, source URL, category,
  and the SHA-256 the genuine bytes must hash to. Each entry is a
  real document fetched from its source and verified at build time;
  no entry may be replaced with hand-written or stub text.
- **Content-addressed storage** — documents live in the `screener`
  R2 bucket under `knowledge/<category>/<sha256>` keys, written by
  `putKnowledgeDoc` (`src/services/knowledgeCorpus.ts`) through the
  BlobStore port, with a metadata record in DO storage. Upload is
  hash-idempotent: an existing record with the same hash returns
  without rewriting. Unlike the report store seams, the upload
  **can** fail its caller — validation and hash errors are typed
  (`KnowledgeCorpusError`), not swallowed.
- **Integrity states** — the corpus sync (`src/services/corpusSync.ts`)
  reconciles manifest against bucket and records, reporting each
  entry as present, **missing**, **mismatched**, or **not ingested**
  (no recorded hash), plus extras. The Corpus tab's integrity report
  is the ground truth of what is actually in the bucket; a sync run
  verifies and backfills — it does not fetch documents. Seeding
  happens only through upload.
- **Current seed state (2026-11-06)** — the manifest is corrected
  and live (PR #3528: FINRA Rule 4210 re-registered at its verified
  refetch hash after the live page drifted; the broker-branded
  order-types entry replaced by the SEC's Investor.gov bulletin,
  per [neutrality-census.md](neutrality-census.md)). Upload of the
  three verified documents proceeds through the Corpus tab.

## Indexing

Indexing rides the shared executor `runAiSearchIndexUpload`
(`src/agents/aiSearchPaths.ts`) — the items API of the AI Search
namespace binding. There is one uploader; two hooks call it:

- **Reports (#2246, as-built)** — `src/services/reportAiSearchIndex.ts`
  fires at the canonical report-store seams. Document id
  `report:<reportId>`, metadata carries kind, report id, run id,
  owner login, source, stored-at. Best-effort: indexing never fails
  the store. There is deliberately **no backfill** — historical
  reports are not silently migrated into the index.
- **Corpus (#3345, as-built)** — `src/services/corpusAiSearchIndex.ts`
  is the corpus bridge: document id `corpus:<bucketKey>`, metadata
  carries kind, key, hash, title, category, source URL. It hooks
  the upload route after a successful put, and the sync's backfill
  leg (manifest ∪ listed `knowledge/` items, hash-verified before
  upload). Text is derived honestly from the served bytes (HTML
  stripped; a PDF contributes its title/source header only — no PDF
  text extractor exists in-repo, and lossy decoding would index
  garbage). Gated by `AI_SEARCH_CORPUS_INDEXING_ENABLED` (on in
  production, #3375); absence means off.

## Serving and per-login discipline

- **Instance and binding (owner-provided values, 2026-11-05)** —
  instance `screener-search`, namespace `default`, R2-backed
  (bucket `screener`). The app reaches it through the
  `ai_search_namespaces` binding (`{ "binding": "AI_SEARCH",
  "namespace": "default", "remote": true }` in `wrangler.jsonc`,
  #3321) — not through the public endpoint.
- **The agent** — exactly one `AiSearchAgent`
  (`src/agents/aiSearchAgent.ts`, a `PortThink` Durable Object).
  The Search Hub's AiSearchAgent tab calls it through
  `POST /search/ai-agent` (#3323) with the caller's session login
  threaded through. Search is three-path (namespace binding, then
  MCP if configured, then REST) per `aiSearchPaths.ts`.
- **Per-login discipline** — report results are filtered to the
  caller's login on the agent path; a report is only ever served to
  its owner. Corpus results (kind `corpus`) are never withheld by
  that filter — the curated library is shared by design. Both
  directions are pinned by tests. Provenance is rendered with every
  result: which document, which serving path.

## The public endpoint, and its retirement (in-flight)

The instance's public endpoint is unauthenticated by design; the
app's per-login filtering exists only at the app layer. The owner's
direction (2026-11-05): it must not stay public. The sequence is
**migrate first, then disable** (#3342): the remaining REST
consumers (Search Hub path, MAS `searchKnowledge`, the MCP
`ai_search_financial_docs` command) move onto the binding/agent
door, `AI_SEARCH_ENDPOINT` is deleted from configuration, and only
then does the owner disable the endpoint in the dashboard. The
broker-neutral rename that preceded this (`AiSearchInstanceService`,
#3322 — the service never had broker coupling) is part of the same
programme; its deprecated alias retires with #3342.
