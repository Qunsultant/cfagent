/**
 * Issue #1743 — observability port conformance suite.
 *
 * The same contract, run unchanged against both runtimes: the
 * Cloudflare Analytics Engine adapter (bound to a stub dataset,
 * the way production binds the live dataset) and the in-memory
 * adapter. A second adapter passing the same suite is the
 * independence proof for the port: swapping runtimes never
 * touches observability domain code.
 *
 * Contract: scope fields present on every event (null when the
 * boundary has no scope); writes never throw (degradation);
 * sensitive fields never reach the adapter payload.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SafeObservabilitySink,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "../src/observability/observabilityPorts";
import {
  AnalyticsEngineObservabilityAdapter,
  eventToDataPoint,
} from "../src/observability/cfAnalyticsEngineAdapter";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";

function baseEvent(over: Partial<ObservabilityEvent> = {}): ObservabilityEvent {
  return {
    type: "http.request",
    level: "info",
    operation: "http.request",
    tenantId: null,
    actorId: null,
    agentId: null,
    component: null,
    runId: null,
    sessionRef: null,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    timestampMs: 1700000000000,
    timestampIso: "2023-11-14T22:13:20.000Z",
    durationMs: 42,
    fields: { method: "GET", status: 200 },
    ...over,
  };
}

/** AE stub dataset capturing datapoints. */
function stubDataset() {
  const points: Array<{
    indexes?: unknown[];
    doubles?: number[];
    blobs?: unknown[];
  }> = [];
  return {
    points,
    dataset: {
      writeDataPoint(point: {
        indexes?: unknown[];
        doubles?: number[];
        blobs?: unknown[];
      }) {
        points.push(point);
      },
    },
  };
}

/** Fresh adapter pair per test — no shared state across tests. */
function makeAdapter(name: "in-memory" | "analytics-engine"): {
  sink: ObservabilitySink;
  read: () => ObservabilityEvent[];
} {
  if (name === "in-memory") {
    const mem = new InMemoryObservabilityAdapter();
    return { sink: mem, read: () => mem.events };
  }
  const ae = stubDataset();
  const aeAdapter = new AnalyticsEngineObservabilityAdapter(ae.dataset as never);
  return {
    sink: aeAdapter,
    read: () =>
      ae.points.map((p) => {
        const blobs = (p.blobs ?? []) as string[];
        // Blobs 7–10 are the §2.2 attributes (actorId, agentId,
        // component, timestampIso); the fields JSON is last.
        const fields = blobs[11] ? JSON.parse(blobs[11]) : {};
        return {
          type: blobs[0] ?? "",
          level: blobs[1] as ObservabilityEvent["level"],
          operation: blobs[2] ?? "",
          tenantId:
            (p.indexes?.[0] as string) === "none"
              ? null
              : (p.indexes?.[0] as string),
          actorId: blobs[7] ? blobs[7] : null,
          agentId: blobs[8] ? blobs[8] : null,
          component: blobs[9] ? blobs[9] : null,
          runId: blobs[3] ? blobs[3] : null,
          sessionRef: blobs[4] ? blobs[4] : null,
          traceId: blobs[5] ?? "",
          timestampMs: 0,
          timestampIso: blobs[10] ?? "",
          durationMs: p.doubles?.[0],
          count: p.doubles?.[1],
          errorCode: blobs[6] ? blobs[6] : undefined,
          fields,
        } satisfies ObservabilityEvent;
      }),
  };
}

describe("observability port conformance", () => {
  for (const name of ["in-memory", "analytics-engine"] as const) {
    describe(name, () => {
      it("writes an event with scope fields present (null when unknown)", async () => {
        const { sink, read } = makeAdapter(name);
        await sink.write(baseEvent());
        const [e] = read();
        expect(e.type).toBe("http.request");
        expect(e.tenantId).toBeNull();
        expect(e.actorId).toBeNull();
        expect(e.agentId).toBeNull();
        expect(e.component).toBeNull();
        expect(e.timestampIso).toBe("2023-11-14T22:13:20.000Z");
        expect(e.runId).toBeNull();
        expect(e.sessionRef).toBeNull();
        expect(e.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(e.durationMs).toBe(42);
        expect(e.fields.method).toBe("GET");
      });

      it("writes batches in order", async () => {
        const { sink, read } = makeAdapter(name);
        await sink.writeBatch([
          baseEvent({ operation: "a" }),
          baseEvent({ operation: "b" }),
        ]);
        const events = read();
        expect(events.map((e) => e.operation)).toEqual(["a", "b"]);
      });

      it("redacts sensitive fields before the payload lands", async () => {
        const { sink, read } = makeAdapter(name);
        await sink.write(
          baseEvent({ fields: { password: "hunter2", ok: 1 } }),
        );
        const [e] = read();
        expect(e.fields.password).toBe("***");
        expect(e.fields.ok).toBe(1);
        expect(JSON.stringify(e)).not.toContain("hunter2");
      });
    });
  }
});

describe("eventToDataPoint mapping", () => {
  it("maps tenant to the single index, measures to doubles, rest to blobs", () => {
    const point = eventToDataPoint(
      baseEvent({
        tenantId: "tenant-a",
        runId: "run-1",
        sessionRef: "abc123def456",
        errorCode: "http.500",
        count: 3,
      }),
    );
    // Exactly one index: Analytics Engine drops datapoints
    // with multiple indexes, and the SQL table has only index1.
    expect(point.indexes).toEqual(["tenant-a"]);
    expect(point.doubles).toEqual([42, 3]);
    expect(point.blobs?.[0]).toBe("http.request");
    expect(point.blobs?.[1]).toBe("info");
    expect(point.blobs?.[2]).toBe("http.request");
    expect(point.blobs?.[3]).toBe("run-1");
    expect(point.blobs?.[4]).toBe("abc123def456");
    expect(point.blobs?.[5]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(point.blobs?.[6]).toBe("http.500");
    // The §2.2 attributes ride as blobs 7–10 (empty scope reads
    // "" here); the fields JSON stays last at 11.
    expect(point.blobs?.[7]).toBe("");
    expect(point.blobs?.[8]).toBe("");
    expect(point.blobs?.[9]).toBe("");
    expect(point.blobs?.[10]).toBe("2023-11-14T22:13:20.000Z");
    expect(JSON.parse(point.blobs?.[11] as string)).toEqual({
      method: "GET",
      status: 200,
    });
  });

  it("null scope maps to the documented sentinels, never to a crash", () => {
    const point = eventToDataPoint(baseEvent());
    expect(point.indexes).toEqual(["none"]);
    expect(point.blobs?.[3]).toBe("");
    expect(point.doubles).toEqual([42, 1]);
  });
});

describe("SafeObservabilitySink degradation", () => {
  it("an adapter failure degrades to local logging and never throws", async () => {
    const failing: ObservabilitySink = {
      write: () => {
        throw new Error("AE down");
      },
      writeBatch: () => {
        throw new Error("AE down");
      },
    };
    const logged: string[] = [];
    const safe = new SafeObservabilitySink(failing, (m: string) =>
      logged.push(m),
    );
    await expect(safe.write(baseEvent())).resolves.toBeUndefined();
    await expect(safe.writeBatch([baseEvent()])).resolves.toBeUndefined();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join()).toContain("observability");
  });

  it("a throwing log callback still never throws", async () => {
    const failing: ObservabilitySink = {
      write: () => {
        throw new Error("AE down");
      },
      writeBatch: () => {
        throw new Error("AE down");
      },
    };
    const safe = new SafeObservabilitySink(failing, () => {
      throw new Error("log down");
    });
    await expect(safe.write(baseEvent())).resolves.toBeUndefined();
  });
});

describe("console sink (unbound degradation)", () => {
  it("writes JSON locally instead of failing", async () => {
    const { ConsoleObservabilitySink } = await import(
      "../src/observability/observabilityPorts"
    );
    const seen: unknown[] = [];
    const info = console.info;
    console.info = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      const sink = new ConsoleObservabilitySink();
      await sink.write(baseEvent());
    } finally {
      console.info = info;
    }
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen[0])).toContain("http.request");
  });
});

vi.stubGlobal("console", console);
