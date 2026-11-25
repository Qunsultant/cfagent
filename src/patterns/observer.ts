/**
 * GoF Observer Pattern & GRASP Pure Fabrication: Event Observability
 *
 * Decouples audit log generation from downstream persistence (SQLite, Cloudflare analytics, console).
 * Satisfies:
 * - Single Responsibility Principle (SRP): Publisher coordinates listeners, observers handle sinks.
 * - Open/Closed Principle (OCP): New observers (e.g. DataDog, Webhooks) attach without altering publishers.
 * - Low Coupling & High Cohesion: Commands and agents don't couple to database tables for logging.
 */

import type { IAuditObserver, IAuditPublisher, AuditEvent } from "./interfaces";
import { auditEventPort } from "../data/createAuditEventPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "patterns/observer",
});

export class AuditEventPublisher implements IAuditPublisher {
  private observers: Set<IAuditObserver> = new Set();

  constructor(private sessionId: string) {}

  subscribe(observer: IAuditObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  publish(type: string, agent: any, payload: Record<string, unknown>): void {
    const event: AuditEvent = {
      id: `evt_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: this.sessionId,
      type,
      agent: String(agent || "orchestrator"),
      payload,
      timestamp: new Date().toISOString(),
    };

    for (const observer of this.observers) {
      try {
        observer.onAuditEvent(event);
      } catch (err) {
        structuredLog.error("audit.observer_notification_failed", {
          message: "AuditObserver error during notification",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
        });
      }
    }
  }

  getObserverCount(): number {
    return this.observers.size;
  }
}

/**
 * Concrete Observer: Persists audit events into D1 via the async
 * audit event port (#6102 — the DO mas_events table is frozen at
 * cutover; new rows land in D1). The observer interface is sync,
 * so the D1 write fire-and-forgets: a failed write warns and never
 * fails or blocks the publisher, and no waitUntil exists at the
 * construction sites (facade) to register the write on.
 */
export class D1AuditObserver implements IAuditObserver {
  constructor(private env: { AGENT_DB?: unknown } | undefined) {}

  onAuditEvent(event: AuditEvent): void {
    void (async () => {
      try {
        const port = await auditEventPort(this.env);
        if (!port) return;
        await port.create({
          id: event.id,
          sessionId: event.sessionId,
          type: event.type,
          agent: (event.agent as any) || "orchestrator",
          payload: (event.payload as any) || {},
          createdAt: event.timestamp,
        });
      } catch (err) {
        structuredLog.warn("audit.d1_record_failed", {
          message: "D1AuditObserver failed to record event",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
}

/**
 * Concrete Observer: Streams audit events to console or debugging telemetry
 */
export class TelemetryAuditObserver implements IAuditObserver {
  public recordedEvents: AuditEvent[] = [];

  onAuditEvent(event: AuditEvent): void {
    this.recordedEvents.push(event);
  }
}
