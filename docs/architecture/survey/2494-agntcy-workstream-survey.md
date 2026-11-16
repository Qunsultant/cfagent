# #2494 AGNTCY workstream — survey

Surveyed 2026-11-01. Code state: fresh shallow clone of Qunsultant/cfagent at
main `ad6b4abf` (2026-11-01T13:13Z), `~/workspace/cfagent-agntcy-survey`.
Web sources accessed 2026-11-01; URLs cited inline. Anything not verified is
marked UNVERIFIED. Survey only — no code changed, no issue/PR created.

## 1. AGNTCY's actual current state (primary sources)

AGNTCY: Cisco-originated (open-sourced Mar 2025), donated to the Linux
Foundation 2025-07-29; 75+ member orgs. Components: OASF, Directory, Identity,
SLIM (messaging), Observe, SHADI, CSIT. Docs hub: https://docs.agntcy.org

### OASF (Open Agentic Schema Framework)
- Repo https://github.com/agntcy/oasf — latest release **v1.1.0**
  (2026-07-10, https://github.com/agntcy/oasf/releases/tag/v1.1.0). Semver;
  released schema versions are immutable except non-breaking doc/bug fixes
  (README, "Schema Versioning and Immutability").
- The record object (schema/objects/record.json on main) requires: `name`,
  `version`, `schema_version`, `description`, `authors`, `created_at`,
  `skills`; recommends `domains`, `modules`; optional `locators`,
  `annotations`. Skills/domains are **taxonomy class IDs** from OASF's
  OCSF-derived hierarchical taxonomies — not free text. This is the one
  non-mechanical part of any generator (see §2.1).
- Protos on Buf (buf.build/agntcy/oasf); schema also published as an OCI
  image (`ghcr.io/agntcy/oasf-schema:<version>`); a hosted schema/validation
  server runs at schema.oasf.outshift.com (Cisco Outshift-hosted).
- AGNTCY itself ships a "Directory MCP Server" that generates/validates
  OASF records and converts **from MCP and A2A formats** into OASF —
  i.e. MCP-catalog → OASF is an intended, upstream-supported mapping.

### Directory (Agent Directory Service, ADS)
- Repo https://github.com/agntcy/dir — artifacts at **v1.8.0**. Spec is an
  IETF **Internet-Draft** (draft-mp-agntcy-ads, July 2026 rev., expires
  2027-01-07; https://spec.dir.agntcy.org) — not an RFC.
- Architecture: OASF records stored as **OCI artifacts**, content-addressed
  (CID), Kademlia DHT routing, Sigstore signing of records.
- API shape: **gRPC** (proto in repo); SDKs for Go, Python, **JavaScript**
  (npm). CLI `dirctl`.
- Deployment is **self-host only** per the repo README: `dirctl daemon`
  (single process, embedded SQLite + local OCI store, localhost:8888),
  Docker Compose, or Helm. **No hosted public directory endpoint is
  documented.** A public hub (`hub.agntcy.org/explore`) is referenced in
  AGNTCY identity material, but the host did not resolve on 2026-11-01 —
  hosted-directory availability: **UNVERIFIED**.

### Identity — the DID interop is real, not a naming resemblance
- https://spec.identity.agntcy.org + repo agntcy/identity (Go): W3C DIDs +
  W3C Verifiable Credentials. "Agent Badges" are enveloped VCs whose
  `credentialSubject` is an OASF record, an A2A Agent Card, or MCP server
  metadata. Issuer node + CLI, vault-held keys, verification via published
  JWKS; BYOID (e.g. Okta-issued IDs) supported alongside DID-assigned IDs.
- So AGNTCY identity = resolvable identity + issuer-signed VCs + published
  verification material. Compare cfagent §2.3: the mechanism gap is large.

### Observability
- Observe SDK (https://docs.agntcy.org/obs-and-eval/observe-sdk/): the
  "AGNTCY Observability Data Schema" is an **extension of OpenTelemetry**,
  aligned with the OTel GenAI semantic conventions; framework-agnostic SDK
  (Python; agntcy/observe) exporting OTLP traces/metrics, with built-in
  instrumentation for A2A, SLIM, and MCP, and trace recomposition via OTel
  context propagation. There is no separate AGNTCY wire protocol for
  telemetry — it is OTel with AGNTCY attributes.

## 2. Mapping onto cfagent (main ad6b4abf)

### 2.1 Part 1 — OASF publication from the catalog
**Current state.** Two sources of truth already exist and both are pinned by
drift tests: (a) the MCP catalog — `McpToolFactory` registrations across
`src/mcps/openaimp/{commands,etradeCommands,marketDataCommands,
agenticPaymentCommands,agentDbReadCommands,goalChainCommands,
meshDoorCommands,cloudflareAgentCommands}.ts`, exposed as `MCP_TOOLS`
(83 tools: name, description, inputSchema) plus `MCP_SERVER_INFO` /
`OPENAIMP_MCP_SERVER_NAME` in `src/mcps/openaimp/index.ts`; (b) the fleet —
`src/agents/registry.ts` identity records (class, DID, doors, budgets) and
`src/a2a/agent-cards.ts` (15 public cards with capabilities/operations,
already served publicly at `/.well-known/agent-card.json` and
`/a2a/<surface>/agent-card.json`).

**Generation shape.** One OASF record per A2A surface/agent derived from
registry identity + agent card (name, version, description, authors,
locators = the existing card/endpoint URLs), and one record for the MCP
server derived from `MCP_SERVER_INFO` + `MCP_TOOLS`. The only curated
artifact is a capability→OASF-skill-class mapping table (taxonomy IDs are
not derivable from tool names); unmapped capabilities must fail the
generator loudly or land in a namespaced extension — never free-text in
`skills`. Drift defence, same pattern as S1/S14: pin tests asserting
record-set == registry surface-set and server-record tools == `MCP_TOOLS`,
so a catalog/registry change without a generator update fails CI. That is
what keeps this from becoming the second hand-maintained registry the
workstream forbids.

**Value:** real but preparatory — OASF records are the prerequisite
artifact for both Directory publication (§2.2) and identity badges
(§2.3). Nothing consumes them yet.
**Size:** small–medium, build-time only; no runtime path touched.
**Risk:** disclosure scoping. Agent records disclose ≈ what the A2A cards
already publish. The **MCP server record is materially wider**: the full
83-tool catalog names internal surfaces (e.g. `query_table_data`,
`manage_referrals`, revenue reads) that no public card exposes today.
Which records may ever be published — and whether the server record is
included — is an **owner decision**, not an engineering default.

### 2.2 Part 2 — Directory for cross-boundary discovery
**Current state.** cfagent has a consumption-side MCP client precedent
(`src/mcps/public/` = client to Public.com's hosted MCP, and #2496's
loopback consumption of our own server), so a Directory client would sit
in the same shape: a port + a discovery-only command, never in the
identity path.
**Blockers.** (1) There is no verified hosted directory to query — the
deployment model is self-host a node (OCI registry + DHT participation =
new infrastructure) to join a network with no known population.
(2) Transport: the Directory API is gRPC; whether the JS SDK offers a
transport usable from a Cloudflare Worker (gRPC-Web/HTTP proxy) is
**UNVERIFIED** — Workers cannot speak raw gRPC/h2c to arbitrary hosts.
**Value today:** near zero — no named external fleet exists for us to
discover, and no external party is asking to discover us through ADS.
**Verdict: DEFER.** Triggers: (a) a named external agent/fleet, actually
listed in a reachable directory, that the owner wants discovered;
(b) a reachable hosted ADS endpoint exists (verify hub.agntcy.org or
successor); (c) the owner decides cfagent should be discoverable *by*
others — which is part-1 publication + a self-hosted node, a separate
decision with its own disclosure review.

### 2.3 Part 3 — Identity alignment with S16 DID attestation
**What S16 actually produces today** (`src/a2a/meshCredentials.ts`,
`src/agents/did.ts`): per-surface bearer credentials
(`A2A_TOKEN_<SURFACE>`, timing-safe compare) with two-part attribution
strings; DIDs of the form `did:agent:openaimp:<role>` (`AGENT_DIDS`,
mirrored in registry identity records) with in-code DID documents
(`resolveAgentDidDocument`); attestation proofs are HMAC-SHA256
(`HmacSha256Verification2026`) **only when `DID_ATTESTATION_KEY` is set**,
else an unkeyed content label (`UnkeyedContentLabel2026`) that is
explicitly not a proof. Production still runs the shared transitional
token and the key is unset (S16 rollout = owner-deferred config), so
production attestations today are unkeyed labels.
**Gap to AGNTCY identity:** `did:agent:` is a private, unregistered DID
method — not resolvable by any W3C resolver; there is no issuer, no VC
issuance, no JWKS publication. Real alignment means asymmetric signing
keys + a badge-issuance path (their reference issuer is a Go service) —
a platform build, not a format tweak.
**Verdict: DEFER**, sequenced *behind* the S16 rollout. Issuing
verifiable badges on top of a transitional shared token and unkeyed
labels would attest an identity strength the underlying credential state
does not have. Trigger: S16 rollout complete (per-surface secrets +
`DID_ATTESTATION_KEY` set in production) **and** a named external
verifier/consumer for the badges.

### 2.4 Part 4 — Observability interop vs S17
**S17 shape** (`src/agents/registry.ts` trace spine, `agent_mesh_trace_hops`,
migration 0023, `src/data/d1MeshTraceAdapter.ts`): `MeshTraceHop` =
W3C traceId (= mesh trace id), spanId, parentSpanId, kind, operation,
timestampMs, tenantId, caller, agent, jobId, note; read via
`agentdb.trace.get`. Four breaks are recorded honestly in the spine
(route-originated workflow starts untraced; channel ingresses untraced;
TradingTradeWorkflow and PaymentWorkflow internal steps unspanned).
**Interop surface:** cfagent has **no OpenTelemetry dependency at all**
(`package.json`: zero matches) — observability is the custom sink in
`src/observability/`. The shared substrate with AGNTCY Observe is the
W3C traceparent id itself, which S17 already carries end-to-end. The
interop artifact, when wanted, is a pure read-side mapping
`MeshTraceHop[]` → OTLP span JSON with AGNTCY/GenAI attributes — no
re-instrumentation.
**Value today:** low. No external MAS consumes our traces; an export
would inherit the four recorded breaks and must mark itself partial.
**Verdict: DEFER.** Trigger: a named external observability consumer, or
a separate decision to adopt OTel natively (at which point the AGNTCY
schema is a thin attribute layer on top).

## 3. Recommendation

**Do one bounded slice now: local OASF record generation (part 1, minus
publication). Defer parts 2–4 on the named triggers above.**

- **In scope:** a pure generator module (proposed
  `src/services/oasfRecords.ts`) deriving (i) one record per fleet agent
  from registry identity records + `AGENT_CARDS`, (ii) one MCP server
  record from `MCP_SERVER_INFO` + `MCP_TOOLS`; a pinned
  capability→skill-class mapping table against OASF **v1.1.0**; a
  structural validator for the record contract (required fields per
  schema/objects/record.json, skill IDs drawn only from the mapping
  table); drift-pin tests (record set == surface set; server record ==
  catalog; adding a tool/surface without a mapping fails).
- **Out of scope:** any HTTP route serving records; any publication to
  any directory; Directory client; identity/badge changes; OTel export;
  runtime behavior changes of any kind.
- **Files:** `src/services/oasfRecords.ts` (new),
  `tests/oasf_records_<issue>.test.ts` (new), `changelog.d/<issue>-oasf-records.md`
  (new). Nothing else should need to change; the generator reads existing
  exports only.
- **Proof it works:** pin tests demonstrably fail when a tool or surface
  is added without a record update; generated records validate against
  the v1.1.0 record contract in tests; a checked-in sample output is
  diff-reviewed in the PR. No production claim is made — this is a
  build-time artifact; cross-boundary proof belongs to a later
  publication slice the owner scopes.
- **Preserved owner decisions:** publication scope (which records, esp.
  the MCP server record), Directory participation, badge issuance.

## 4. DRAFT §5 issue body (not filed)

---

**Title:** feat(oasf): generate OASF records from the mesh registry and MCP catalog (local only, no publication) #CAIO-quns

## Problem

The #2494 AGNTCY workstream (tracker comment 6531565279) starts with OASF
publication from the catalog. AGNTCY's Directory and identity badges both
consume OASF records, but cfagent has no OASF representation of its fleet
or its MCP server. Hand-writing records would create a second,
hand-maintained capability inventory next to the two sources of truth
that already exist (the mesh registry / A2A agent cards and the
`McpToolFactory` catalog) — the exact drift failure this programme's
S1/S14 pins exist to prevent. Survey:
`~/workspace/cfagent-mesh/agntcy-workstream-survey.md` (2026-11-01).

## Proposal

A pure, build-time generator that derives OASF records (schema v1.1.0)
from the existing sources only:

- One record per fleet agent, from registry identity records +
  `AGENT_CARDS` (locators = the already-public card/endpoint URLs).
- One record for the MCP server, from `MCP_SERVER_INFO` + `MCP_TOOLS`.
- Capabilities map to OASF taxonomy skill classes through one pinned
  mapping table; an unmapped capability fails generation loudly (or
  lands in a namespaced extension by explicit table entry) — never
  free-text in `skills`.
- A structural validator checks generated records against the OASF
  v1.1.0 record contract (required fields; skill IDs only from the
  mapping table).

Generation is local only: no route serves the records, nothing is
published anywhere. Publication scope (which records, including whether
the MCP server record — which exposes the full 83-tool catalog — may
ever leave the building) is a separate owner decision, as are Directory
participation and AGNTCY badge issuance (survey §2.2/§2.3, deferred with
named triggers).

## Acceptance criteria

- [ ] Generator produces one record per registry surface/agent and one
      server record; record set is proven equal to the source sets by
      pin tests (a new tool, surface, or unmapped capability fails CI).
- [ ] Every generated record validates against the pinned OASF v1.1.0
      record contract in tests.
- [ ] No new runtime route, no publication, no behavior change: the
      module is imported only by tests and (optionally) a build-time
      script.
- [ ] Full verify-before-merge green; changelog fragment added.

## Reused surfaces

Mesh registry (`src/agents/registry.ts`), A2A agent cards
(`src/a2a/agent-cards.ts`), MCP catalog (`MCP_TOOLS` /
`McpToolFactory`, `src/mcps/openaimp/`), S1/S14 drift-pin test pattern.

## Agent

#CAIO-quns
