## Verified survey: the example itself

#CAIO-quns — surveyed the example tree the owner linked (`cloudflare/agents`, `examples/next/harnesses/self-modifying`, read 2026-11-15 via the repo API: tree listing, README, `package.json`, `src/self-modifying-harness.ts` and `src/harness-runtime.ts` heads). The premise correction in this issue's body HOLDS, now verified against the example's own words.

### What it is

The README states it verbatim: "The class and all of its implementation stay local to this example; this is not an Agents SDK API." It is a `next`-track example (experimental), not a package export. `SelfModifyingHarness` is a local `LifecycleCapability` composed via `Lifecycle.install(this).use(tasks).use(streams).use(webSockets).use(harness)` — the `next` Lifecycle-capability entry points (`agents/lifecycle`, `agents/tasks`, `agents/streams`, `agents/websockets`), not the stable Think/Agent APIs this repo runs on.

### What it does

- Editable TypeScript harness source lives under `/harness` in a durable `@cloudflare/computer` Workspace (`sql: this.ctx.storage.sql, namespace: "self_modifying"`).
- Activation snapshots the source, bundles it with `@cloudflare/worker-bundler` (`createWorker`), checks it in an isolated Dynamic Worker, and moves the active-revision pointer only after the check passes.
- Every chat turn pins one revision and loads it with `WorkerLoader.load()` — fresh isolate per turn, no module globals carried between turns.
- Two tool types: System tools (fixed, trusted, execute in the DO via RPC — read/write source, activate/restore revisions, journal entries) and Custom tools (editable `CustomTool` exports under `/harness/src/tools/`, execute inside the turn's Dynamic Worker; the agent can create/replace them; a Custom tool cannot shadow a System tool; activation auto-discovers them and generates the registry).
- Turn-scoped RPC authority + effect journal (`host-bridge.ts`); model is AI SDK 7 `LanguageModelV4` (the example passes a Workers AI model from `workers-ai-provider@4`, `@cf/moonshotai/kimi-k2.7-code`).
- No authentication in the example ("put it behind your own before exposing it"). Worker Loader access is required (early-access example). Design rationale + measured evidence: `design/rfc-self-modifying-harness.md` in the agents repo.
- Tests cover: V4 model conversion, fresh isolates, queued Tasks execution, Streams events, source activation, failed-candidate recovery, System/Custom composition, System-name collision rejection, automatic Custom tool discovery, use on the next revision, forward restore.

### Adoption shape for cfagent (what the evaluation must answer)

Adopting the pattern is NOT a PortThink slice — it would be a second harness beside Think, on the `next` track, needing: new dependencies (`@cloudflare/computer`, `@cloudflare/worker-bundler`, `@cloudflare/kumo`, AI SDK 7 — cfagent pins agents 0.32.0 / Think 0.23.0 / AI SDK 5-era surface), a Worker Loader binding (none in `wrangler.jsonc`; early access), an auth layer (none in the example), and a verdict on which agent would rewrite its own source and why. The evaluation's adopt/do-not-adopt verdict must weigh that cost shape against the incumbent improvement loop (#2460 RSI pipeline, #3491 workspace surfacing).

### Correction to my earlier summary

I previously described the example as using "internal SDK APIs". More precisely: it uses the `next` Lifecycle-capability entry points, which are public entry points of the experimental track — the class itself is example-local. The conclusion is unchanged: nothing to enable via PortThink.
