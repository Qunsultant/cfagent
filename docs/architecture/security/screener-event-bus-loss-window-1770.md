# Screener event bus: durability and loss window (#1770 slice C)

## Status

Explicitly carried design: the in-memory `ScreenerEventBus`
(`src/events/screenerEvents.ts`) is retained as fallback/local fan-out,
NOT replaced. No new store or engine was added by #1770 — the durable
primary already existed (#1739, Cloudflare Queue
`screener-events-delivery`), and slice C documents the fallback's loss
window and adds outcome telemetry on the existing Analytics Engine sink.

## Delivery legs

| Leg | Events | Durability |
| --- | --- | --- |
| Cloudflare Queue `#1739` (primary) | `screener.completed`, `screener.failed` | Durable across Worker isolate and instance restarts; CloudEvents envelopes; dedup by delivery id |
| In-process `ScreenerEventBus` (fallback) | Same two types, only when the queue is unreachable or no subscriber stream received the event | None — see loss window below |
| Legacy bus only (no queue leg) | `options.*` events | None — delivery stays on the #223 direct path; no bus subscribers today |

`ScheduledTasksService.publishScreenerEvent` (`src/services/scheduledTasks.ts`)
tries the queue first for `screener.*`, falls back to the bus, and never
delivers twice: the bus leg runs only when no subscriber stream received
the event.

## The loss window (in-process bus)

An event published to the in-process bus is lost if the isolate or
Durable Object instance restarts — or a new instance serves — before
every subscriber's handler completes. There is no persistence, no replay,
and no redelivery. The window opens at bus publish and closes when the
last subscriber handler returns; anything in flight across a restart is
gone. The only evidence left behind is the publisher's console warning
(queue-fallback notice) in the Worker logs.

Consequences, stated plainly:

- A Slack/email/webhook notice whose delivery was fallback-leg and
  in-flight across a restart is never re-sent by any component.
- `options.*` outcomes have no durable leg at all, so the same window
  applies to them without any queue behind it.
- The run itself is not lost: scheduled runs are recorded as task
  results, and since slice C the publish path also writes one
  `screener.delivery` telemetry point per non-chained `screener.*`
  event to the existing Analytics Engine sink (folded by
  `foldEnvelopeToEvent` in `src/observability/observabilityPorts.ts`,
  written by `writeScreenerEventTelemetry` in
  `src/services/scheduledTasks.ts`). Telemetry is an outcome record,
  not redelivery: it never re-sends a notice.

## Degradation and operator notes

- The observability sink degrades, never fails: absent `OBSERVABILITY`
  binding, `createObservabilitySink` returns the console sink (#1743
  criterion — Analytics Engine unavailability never fails the
  request), and the sink is Safe-wrapped, so a dataset failure warns
  and never fails the run or its deliveries.
- The chained followup path (`followupScheduler`) is excluded from the
  publish-path telemetry emission: chained delivery owns its own
  outcome reporting, and emitting here as well would double-record
  chained runs.
- If the queue binding is absent in a deployment, every `screener.*`
  delivery is fallback-leg and carries the loss window above. That is
  a deployment configuration fact, not a code gap — but it should be
  visible in that deployment's run logs (queue-fallback warnings) and
  in the absence of queue deliveries.

## Related

- #210 (event bus), #223 (options direct delivery path), #462
  (qualified partial results), #1739 (durable queue primary), #1743
  (observability sink), #1717 (parent unification program).

#CISO-bhdm
