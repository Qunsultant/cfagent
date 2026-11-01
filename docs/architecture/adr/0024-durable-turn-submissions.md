# 0024. Durable chat-turn submission via Think's submission queue

- Status: accepted
- Date: 2026-10-31
- Deciders: owner (programme #2494 direction), CAIO-quns
- Issue: #2566 (programme #2494)
- Implementing PR: (to be filled on merge)

## Context

OrchestratorAgent inherits Think's durable submission machinery
(`submitMessages`: a persisted submission queue with FIFO execution,
idempotency keys, recovery of pending submissions on start, and
`waitForSubmission` / `inspectSubmission` inspection) but never called
it — a full-repo search found zero call sites. The HTTP/programmatic
chat-turn driver (`runAgenticChatTurn`, the single-owner turn pipeline
behind POST /api/chat and the channel admissions that reach it through
the route context) instead drove the actor-port turn facet in wait
mode: a blocking, in-memory drive whose only record of the turn was
the in-memory `pendingTurn` stash.

Issue #1738 recorded the consequence plainly: the stash is in-memory
only, there is no durable turn sealing on eviction. A Durable Object
eviction or restart mid-turn lost the turn — the caller got an error
or the degraded fallback and the user's message never completed.
ADR 0005 listed durable turn sealing (D2) as an out-of-scope
follow-up; the #2494 Think-harness audit re-surfaced it (submitMessages
inherited but never called). This ADR lands D2 for the
HTTP/programmatic submission path.

## Decision

`runAgenticChatTurn` submits the turn through Think's durable
submission queue and collects the outcome via `waitForSubmission` /
`inspectSubmission` (implementation:
`src/agents/orchestrator/durableTurnSubmission.ts`, composed by the
class in the #992 extraction pattern). The submission is persisted
before it runs, so a turn submitted just before an instance restart
still completes afterwards; a caller-supplied idempotency key makes a
duplicate submission collect the original outcome instead of executing
a second turn.

Three pieces of the old drive the SDK mechanism does not carry are
kept, deliberately, beside it:

- **The synchronous {result, route} return.** The route is decided
  inside the executed turn (`portBeforeTurn`), and a submission
  inspection carries no route. The driver correlates by a request id
  stamped into the user message's metadata; `portBeforeTurn` adopts
  it and records the route in a bounded map the driver reads after
  the submission settles.
- **Port-transcript parity.** The actor (port) session stays the
  canonical transcript the routes read. The driver appends the user
  message before submitting and mirrors the assistant message back
  on completion, both upsert-by-id. Think's tree session remains the
  second store it already was (cleared alongside the port store by
  `clearMessages`).
- **The epoch abort.** A memory reset cancels the in-flight
  submission (`abortAllRequests`) and a turn settling after its
  epoch lands the retired facet drive's aborted shape — empty text,
  route kept, nothing mirrored into the cleared transcript.

Caller inputs the facet drive received directly (verified identity,
source tab, the Judge's recent-turns context, the auto-research
flag) ride the submitted message's metadata and are adopted by
`portBeforeTurn` over the session derivation, so no caller input is
lost. The executed turn otherwise derives its inputs exactly as
direct Think turns already do (`deriveTurn`).

## Consequences

- The turn facet (`runFacetTurn` / ThinkActorTurn) is retained: it is
  the actor port's turn surface (the conformance suite runs against
  it) and remains the only path that carries a configOverride turn,
  which the submission queue has no equivalent for. TradingAgent's
  facet turns are untouched.
- WebSocket turns are untouched: Think already drives them through
  the same pipeline hooks.
- The async-job queue (mas_async_jobs) and its semantics for
  non-turn work are untouched.
- A rejected wait (the SDK wait is memory-bound and rejects on
  restart) is re-inspected and re-waited a bounded number of times;
  the submission itself is the durable record, so a caller that
  ultimately gives up has still not lost the turn — its reply lands
  in the transcript when the recovered submission completes.

## Alternatives considered

- **Keep the facet drive and seal the stash durably by hand**
  (persist pendingTurn, resume on start). Rejected: it re-builds
  the SDK's submission queue — persistence, FIFO, idempotency,
  recovery — as a second, home-grown implementation beside the one
  the class already inherits (the reuse-before-build rule, gitops
  §7).
- **Submit only, fire-and-forget, and drop the synchronous
  {result, route} contract.** Rejected: POST /api/chat's response
  contract is consumed by routes and channels today; changing it is
  a caller-visible break with no requirement behind it.
- **Adopt submissions for WebSocket turns too.** Rejected as
  unnecessary: Think's native WS pipeline already persists and
  recovers its turns; the gap ADR 0005 D2 named was the
  request-scoped POST/programmatic path.
