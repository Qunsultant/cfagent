## Survey complete (2026-10-29, base `a71fca57`; full text files to `docs/architecture/survey/` in the ship sequence)

Parent spot-verified the load-bearing claims firsthand. Headlines by goal area:

**Reachability (§1).** Wired-agent from chat: Research, Screener, ReportAsset (indirect via the report pipeline). In-process: options screens, trading, payment drafts, NLQ. Unreachable from chat: ScheduledAgent goals, TradingAgent + its approval door (tests-only callers), PaymentsAgent `processPaidRequest` (no production caller), and **every workflow start**. One structural nuance: the chat turn's tools are the MCP command set — the MAS tools are route-only (sole `createMAS` production caller is the SearchHub route), so "chat capabilities" and "MAS capabilities" are different sets today.

**Conformance (§2).** Fleet-wide: SDK state API used by no agent; zero `onConnect`; only OrchestratorAgent defines `onStart`; sessions are dual-store for the three turn-capable agents. **Fibers: `durableFibers` is home-grown and not durable** — an in-memory `Map`, checkpoints written but never read, the header's recovery callback exists nowhere else. It is a labelling pattern, not the platform primitive.

**Identity (§2/G14).** The synthetic-identity family is larger than the two known cases: orchestrator research-stub `userLogin || "default"` (orchestrator.ts:593), ResearchAgent's fallback + seven propagation sites, PaymentsAgent's `agentId ?? "orchestrator"` (what ScheduledAgent's agentId-less budget calls get attributed to), DID `"anonymous"` derivations, ScreenerAgent `tenantId: "default"` literals, ScheduledAgent's audit actor `"system"`, the NLQ webhook's `nlq_webhook` login, SlackAgent's `slack_agent_master`. **Attestation verdict: the DID proof is an unkeyed SHA-256 (sync variant: a 32-bit string hash), the DID document's key derives from that same hash, and no verify function exists** — G14 unifies a labelling pattern, not a proof; a real attestation needs a keyed construction, decided in the G14 slice. A2A: one shared token, no per-caller distinction; internal stub RPC carries no credential (identity is caller-asserted arguments).

**Workflows (§3).** Screener is the fleet's best (shards, retry limit, idempotent start, deterministic delivery id, D1 projections + Runs UI). Trading: wait-for-event + one settle step, idempotent via the shared core, but **no status surface**. Payment: the most careful money path (deduped ledger writes, replay-safe journal) — but its gate is the monetization gate, **never PaymentsAgent (zero references)**, so G5's budget check is genuinely new wiring. No workflow has a repo eviction/resume test; all workflow tests drive fake steps — G6's proof bar is unmet everywhere today.

**Scheduling (§4).** Evidence supports the ruling as filed: ScheduledAgent = the user-visible goal catalogue; orchestrator self-scheduling = per-login instance machinery. Two anomalies for the G7 slice: the daily research run and the qa sweep are catalogue-shaped work living outside the catalogue.

**Channels (§7).** Nine tabled. Only Slack is MIXED (production ingress = server forwarders to `slack_<teamId>` orchestrator instances; SlackAgent's own gated ingress is a parallel implementation nothing calls).

**Tools (§8).** Fifteen families. Sandbox DEGRADED-honest (only construction passes `undefined` as the container; wrangler declares no containers config). **Browser is also degraded in the deployed config**: the `env.BROWSER` code path is real but wrangler declares no Browser Rendering binding, so captures fall back to the labelled placeholder — a G11 wiring item (binding + verification), not a code gap.

**RSI substrate (§9).** Self-knowledge PARTIAL (catalog + cards are data; no queryable surface); traces PARTIAL (per-programme stores; no cross-agent trace record); **eval harness ABSENT**; self-healing PARTIAL — `handleQAFailure` has **no caller anywhere** (production filing is the external `scripts/qa-smoke.mjs`; the in-worker live half is `/api/qa/investigate`), and `qa.run_sweep` has no in-worker executor; **cost budgets ABSENT** (no token fields in the turn path).

**Two items flagged for decision:**

1. **G0 rename collision (§5).** `OrchestratorAgent` is already a registered class (v9) with its own namespace; a `renamed_classes` migration onto an existing class name is unproven anywhere in the repo. The rename slice's first step must be a preview-deploy proof; if the platform refuses, the fallback sequences (retire the separate ORCHESTRATOR_AGENT registration first) are tabled in the survey §5. Two existing pins actively pin the OLD alias shape and are rewritten in that PR. Existing SEARCH_AGENT state survives a proper renamed_classes migration [platform documentation].
2. **NLQ premium leg (G3 acceptance point, parent-corrected).** The chat/NLQ paid-options leg records a payment receipt with **no payment collected** — the receipt IS honestly labelled (`status: "simulated"`, an explicit note, and the user summary says so, per #122), so this is not a hidden fabrication; but a simulated record is written into the real payments ledger that budget state derives from. G3's acceptance therefore includes: this leg stops recording simulated receipts — verified x402 through the workflow, or an honest refusal — and the treatment of already-recorded simulated rows is named in that slice.

Slice candidates S1–S20 in dependency order are in the survey §6 (every `orchestrator.ts`-touching slice flagged as strictly sequential). Builds sequence behind #2223 where files collide.

#CDO-mha7
