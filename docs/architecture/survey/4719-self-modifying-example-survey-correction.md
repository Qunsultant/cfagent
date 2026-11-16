## Correction: the harness CAN compose onto PortThink — my "not PortThink-enablable" claim was wrong

#CAIO-quns — the owner challenged this ("why can't this be added to existing portthink? just because it is a different api?"), and the challenge holds. I verified the composition mechanics against the pinned SDKs (agents 0.32.0, Think 0.23.0, ai 7.0.123) and the example source. The substrate is SHARED, not foreign. What follows supersedes the premise correction in this issue's body and in my earlier survey comment.

### Verified: the composition path exists

- The Lifecycle entry points exist in pinned agents 0.32.0 (`./lifecycle`, `./tasks`, `./streams`, `./websockets` — no version gate).
- `Agent`'s own constructor installs the Lifecycle (`Lifecycle.install(this, ...)`, stored as public `this.lifecycle`) and composes its capabilities via `.use()` (scheduler, queue, mcp, state, webSockets, tasks, dynamicAgents). Think extends `Agent`, so every PortThink class already HAS a Lifecycle.
- `SelfModifyingHarness extends LifecycleCapability` and claims NO dispatch hooks itself: it registers a durable turn driver on the `Tasks` instance it is given (job `__cf_self_modifying_turn_v1`, namespaced) and exposes its operations (`submit`, `prompt`, `activate`, `restore`, `writeSource`, `snapshot`, `getTurn`) as plain async methods. Its WS protocol is served by a SEPARATE `WebSockets` capability the host composes from `harness.webSockets()`.
- The example host is a plain `DurableObject` only because it is a standalone demo — nothing in the capability requires a non-Agent host.
- The model type aligns: the harness takes AI SDK 7 `LanguageModelV4`; cfagent pins `ai` 7.0.123. Think already provides `this.workspace` (a Computer Workspace), which is the harness's workspace need (namespaced, per the example's `namespace: "self_modifying"` variant).

### Verified: the real constraints (mechanical, not "different API")

1. **No second install.** `Lifecycle.install(this)` cannot be called again — the Agent base already installed one, and `installHandlers()` "more than once is an error". The capability must join via `this.lifecycle.use(...)` before the lifecycle starts.
2. **One WebSockets catch-all.** A second `WebSockets` capability claiming the same upgrade hook is refused by `use()`'s catch-all uniqueness rule. The harness UI protocol cannot ride a second WS capability beside Think's — it needs routing through Think's existing WS surface, a separate route, or no WS at all (its methods are drivable via the port's fetch ingress / MCP tools / RPC without the UI protocol).
3. **Two turn loops is a DESIGN decision, not a mechanical block.** The harness runs turns in fresh Dynamic Workers with its own Streams log and history; Think runs turns with its own tree session. Both on one DO means deciding which surface each serves — the port must route, not just compose.
4. **Hard prerequisites, unchanged:** a Worker Loader binding (absent from `wrangler.jsonc`, early access), `@cloudflare/worker-bundler` (+ `@cloudflare/computer` as a direct dep — today transitive via Think), an auth layer (the example has none), and VENDORING the example-local files (harness, runtime, host-bridge, store, transport, seed, protocol — ~10 files) as a maintained fork, since nothing is exported from a package. That last point is the honest form of "not an SDK API": no upstream updates, we own the code.

### Re-scoped evaluation

The evaluation question is no longer "adopt the pattern or not (PortThink N/A)". It is which shape, decided by the owner:

- (a) **Whole harness as a second door** on a PortThink class: harness turns behind a dedicated route/door, Think keeps chat turns; WS routing + turn routing decided explicitly.
- (b) **Revision machinery only as port operations**: `activate` / `restore` / `snapshot` / `writeSource` through the port, Think keeps ALL turns; Dynamic-Worker tool execution shared with the #4723 skill-runner substrate instead of the harness's turn loop.
- (c) **Do-not-adopt**, with grounds.

The evaluation must also verify the two unchecked compatibilities: `HarnessWorkspace` vs Think's `this.workspace` type, and the resolved Think model vs raw `LanguageModelV4`.
