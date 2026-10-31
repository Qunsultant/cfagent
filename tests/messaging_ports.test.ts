// @vitest-environment node
/**
 * Issue #1739 ([AGENTIC] Queue-backed messaging pipeline, first in the
 * owner's Top-10 priority order) — TDD red-first.
 *
 * Pinned contracts (CloudEvents v1.0 + owner adapter-first override;
 * this slice closes assessment-01.md Recommendation 4, P2 gap):
 *  - The envelope carries the CloudEvents required attributes
 *    (specversion 1.0, id, source, type, time, data) plus lowercase
 *    extensions (subject, correlationid, jobid, parentjobid, shardid,
 *    stage). Mapping from the §11.3 names, semantics unchanged:
 *    eventId → id, eventType → type, timestamp → time,
 *    producer → source, payload → data. No provider concepts.
 *  - Stage-typed events are first-class type values: stageEventType
 *    builds "feed.completed" and siblings; stage must be a known stage.
 *  - The idempotency key IS the id: consuming the same envelope
 *    twice invokes the handler once; the second delivery is a duplicate.
 *  - Consumption dispositions are provider-neutral: "processed" |
 *    "retry" | "drop". The provider adapter alone maps them to its
 *    own ack/retry mechanics — domain code never sees them.
 *  - A handler throw is a "retry", never a consume throw. Invalid
 *    envelopes are counted, never delivered to the handler.
 *  - The SAME conformance suite runs UNCHANGED against the in-memory
 *    adapter and the provider adapter (fake backing queue here): the
 *    in-memory adapter is the standing proof a second implementation
 *    plugs in cleanly.
 *  - Port purity: the port, the envelope translators, the consumer
 *    handler, and the composition root carry no provider concepts;
 *    the provider binding is touched only by the composition root
 *    and the provider adapter. Domain call sites never name the
 *    binding.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isMessageEnvelope,
  deliverEnvelopes,
  MessagingError,
  MAX_ENVELOPE_BYTES,
  stageEventType,
  jobContextFromEnvelope,
  type MessageEnvelope,
  type MessageHandler,
  type MessagingPorts,
  type SubscriberHandlers,
} from "../src/messaging/messagingPorts";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import {
  CfQueueMessagingAdapter,
  consumeCfBatch,
  dispatchSubscriberBatch,
} from "../src/messaging/cfQueueMessagingAdapter";
import { createMessagingPorts } from "../src/messaging/createMessagingPorts";
import {
  toScreenerEnvelope,
  fromScreenerEnvelope,
} from "../src/messaging/screenerEventEnvelope";
import { createScreenerQueueHandler } from "../src/messaging/screenerQueueConsumer";
import type { ScreenerEvent } from "../src/events/screenerEvents";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "scheduled-tasks",
    type: "screener.completed",
    time: "2026-10-26T12:00:00.000Z",
    correlationid: "corr-1",
    data: { hello: "world" },
    ...overrides,
  };
}

function runConformance(name: string, makePorts: () => MessagingPorts) {
  describe(`conformance: ${name}`, () => {
    it("delivers a sent envelope to the handler exactly once", async () => {
      const ports = makePorts();
      const seen: MessageEnvelope[] = [];
      const handler: MessageHandler = async (e) => {
        seen.push(e);
        return "processed";
      };
      await ports.producer.send(envelope());
      // Port-level consume takes explicit envelopes (the adapter's
      // drain/queue mechanics are adapter-private).
      const report = await ports.consumer.consume([envelope()], handler);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.id).toBe("evt-1");
      expect(report.results).toEqual([
        { id: "evt-1", disposition: "processed" },
      ]);
    });

    it("deduplicates redelivery: same id invokes the handler once", async () => {
      const ports = makePorts();
      let calls = 0;
      const handler: MessageHandler = async () => {
        calls += 1;
        return "processed";
      };
      const report = await ports.consumer.consume(
        [envelope(), envelope(), envelope({ id: "evt-2" })],
        handler
      );
      expect(calls).toBe(2);
      expect(report.results.map((r) => r.disposition)).toEqual([
        "processed",
        "duplicate",
        "processed",
      ]);
    });

    it("a retry disposition allows redelivery; a drop does not reprocess", async () => {
      const ports = makePorts();
      let calls = 0;
      const handler: MessageHandler = async () => {
        calls += 1;
        return calls === 1 ? "retry" : "processed";
      };
      const first = await ports.consumer.consume([envelope()], handler);
      expect(first.results[0]?.disposition).toBe("retried");
      const second = await ports.consumer.consume([envelope()], handler);
      expect(second.results[0]?.disposition).toBe("processed");
      expect(calls).toBe(2);

      const dropHandler: MessageHandler = async () => "drop";
      const dropped = await ports.consumer.consume(
        [envelope({ id: "evt-9" })],
        dropHandler
      );
      expect(dropped.results[0]?.disposition).toBe("dropped");
      const redelivered = await ports.consumer.consume(
        [envelope({ id: "evt-9" })],
        dropHandler
      );
      expect(redelivered.results[0]?.disposition).toBe("duplicate");
    });

    it("a handler throw becomes a retry, never a consume throw", async () => {
      const ports = makePorts();
      const handler: MessageHandler = async () => {
        throw new Error("boom");
      };
      const report = await ports.consumer.consume([envelope()], handler);
      expect(report.results[0]?.disposition).toBe("retried");
    });

    it("invalid envelopes are counted, never delivered to the handler", async () => {
      const ports = makePorts();
      let calls = 0;
      const handler: MessageHandler = async () => {
        calls += 1;
        return "processed";
      };
      const report = await ports.consumer.consume(
        [{ id: "x" }, null, envelope()],
        handler
      );
      expect(calls).toBe(1);
      expect(report.results.map((r) => r.disposition)).toEqual([
        "invalid",
        "invalid",
        "processed",
      ]);
      expect(report.results[0]?.id).toBeNull();
    });

    it("sendBatch preserves order; send of an invalid envelope throws a neutral error", async () => {
      const ports = makePorts();
      const got: string[] = [];
      const handler: MessageHandler = async (e) => {
        got.push(e.id);
        return "processed";
      };
      await ports.producer.sendBatch([
        envelope({ id: "a" }),
        envelope({ id: "b" }),
      ]);
      await expect(
        ports.producer.send({ id: "x" } as unknown as MessageEnvelope)
      ).rejects.toBeInstanceOf(MessagingError);
      await expect(
        ports.producer.send({ id: "x" } as unknown as MessageEnvelope)
      ).rejects.toMatchObject({ code: "invalid_envelope" });
      const report = await ports.consumer.consume(
        [envelope({ id: "a" }), envelope({ id: "b" })],
        handler
      );
      expect(got).toEqual(["a", "b"]);
      expect(report.results).toHaveLength(2);
    });
  });
}

describe("messaging port", () => {
  it("envelope validation accepts the §11.3 shape (six required fields)", () => {
    expect(isMessageEnvelope(envelope())).toBe(true);
    expect(isMessageEnvelope({ ...envelope(), source: 7 })).toBe(false);
    expect(isMessageEnvelope({ ...envelope(), data: undefined })).toBe(
      false
    );
    expect(isMessageEnvelope(null)).toBe(false);
    expect(isMessageEnvelope("nope")).toBe(false);
  });

  it("CloudEvents shape: specversion 1.0 required, extensions lowercase", () => {
    expect(isMessageEnvelope(envelope())).toBe(true);
    expect(envelope().specversion).toBe("1.0");
    const { specversion: _drop, ...noVersion } = envelope();
    expect(isMessageEnvelope(noVersion)).toBe(false);
    expect(
      isMessageEnvelope({ ...envelope(), specversion: "2.0" })
    ).toBe(false);
    // A camelCase extension name fails the CloudEvents naming rule…
    expect(
      isMessageEnvelope({ ...envelope(), correlationId: "x" })
    ).toBe(false);
    // …while an unknown all-lowercase key is tolerated as a future extension.
    expect(isMessageEnvelope({ ...envelope(), customext: "x" })).toBe(true);
  });

  it("job-routing extensions are optional, validated when present, stage must be known", () => {
    expect(
      isMessageEnvelope(
        envelope({
          jobid: "job-1",
          parentjobid: "job-0",
          shardid: "shard-9",
          stage: "feed",
        })
      )
    ).toBe(true);
    expect(isMessageEnvelope(envelope({ jobid: 7 as never }))).toBe(false);
    expect(isMessageEnvelope(envelope({ parentjobid: "" }))).toBe(false);
    expect(isMessageEnvelope(envelope({ shardid: "" }))).toBe(false);
    expect(isMessageEnvelope(envelope({ stage: "bogus" as never }))).toBe(
      false
    );
    for (const stage of [
      "feed",
      "gather",
      "analysis",
      "store",
      "serve",
      "deliver",
    ] as const) {
      expect(isMessageEnvelope(envelope({ stage }))).toBe(true);
    }
  });

  it("stageEventType builds first-class stage-typed type values", () => {
    expect(stageEventType("feed", "completed")).toBe("feed.completed");
    expect(stageEventType("gather", "started")).toBe("gather.started");
    expect(stageEventType("analysis", "failed")).toBe("analysis.failed");
  });

  it("jobContextFromEnvelope extracts job context, or null when absent", () => {
    expect(jobContextFromEnvelope(envelope())).toBeNull();
    expect(
      jobContextFromEnvelope(
        envelope({ jobid: "job-1", parentjobid: "job-0", stage: "gather" })
      )
    ).toEqual({ jobId: "job-1", parentJobId: "job-0", stage: "gather" });
    expect(
      jobContextFromEnvelope(envelope({ jobid: "job-1" }))
    ).toEqual({ jobId: "job-1" });
  });

  it("deliverEnvelopes core is order-preserving and total", async () => {
    const seen = new Set<string>();
    const handler: MessageHandler = async () => "processed";
    const report = await deliverEnvelopes(
      [envelope({ id: "1" }), envelope({ id: "2" })],
      seen,
      handler
    );
    expect(report.results.map((r) => r.id)).toEqual(["1", "2"]);
  });

  runConformance("in-memory adapter", () => {
    const adapter = new InMemoryMessagingAdapter();
    return {
      producer: adapter,
      consumer: adapter,
      publisher: adapter,
      subscriber: adapter,
    };
  });

  runConformance("provider adapter over a fake backing queue", () => {
    const sent: unknown[] = [];
    const queue = {
      send: async (body: unknown) => {
        sent.push(body);
      },
    };
    const adapter = new CfQueueMessagingAdapter(queue);
    return {
      producer: adapter,
      consumer: adapter,
      publisher: adapter,
      subscriber: adapter,
    };
  });

  it("provider adapter sendBatch reaches the backing queue in order", async () => {
    const sent: unknown[] = [];
    const queue = {
      send: async (body: unknown) => {
        sent.push(body);
      },
    };
    const adapter = new CfQueueMessagingAdapter(queue);
    await adapter.sendBatch([
      envelope({ id: "a" }),
      envelope({ id: "b" }),
    ]);
    expect((sent as MessageEnvelope[]).map((b) => b.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("provider batch bridge maps dispositions to ack/retry, invalid to ack", async () => {
    const sent: unknown[] = [];
    const queue = {
      send: async (body: unknown) => {
        sent.push(body);
      },
    };
    const adapter = new CfQueueMessagingAdapter(queue);
    const acks: unknown[] = [];
    const retries: unknown[] = [];
    const mkMsg = (body: unknown) => ({
      body,
      ack: () => {
        acks.push(body);
      },
      retry: () => {
        retries.push(body);
      },
    });
    let calls = 0;
    const handler: MessageHandler = async (e) => {
      calls += 1;
      if (e.id === "retry-me") return "retry";
      if (e.id === "drop-me") return "drop";
      return "processed";
    };
    const batch = {
      queue: "screener-events",
      messages: [
        mkMsg(envelope({ id: "ok-1" })),
        mkMsg(envelope({ id: "retry-me" })),
        mkMsg(envelope({ id: "drop-me" })),
        mkMsg({ nope: true }),
      ],
    };
    await consumeCfBatch(batch, adapter, handler);
    expect(calls).toBe(3);
    expect(acks).toHaveLength(3); // ok-1, drop-me, invalid
    expect(retries).toHaveLength(1);
    expect((retries[0] as MessageEnvelope).id).toBe("retry-me");
  });

  it("in-memory adapter drains its own queue", async () => {
    const adapter = new InMemoryMessagingAdapter();
    await adapter.send(envelope({ id: "d-1" }));
    expect(adapter.pendingCount).toBe(1);
    const got: string[] = [];
    const report = await adapter.drain(async (e) => {
      got.push(e.id);
      return "processed";
    });
    expect(got).toEqual(["d-1"]);
    expect(adapter.pendingCount).toBe(0);
    expect(report.results[0]?.disposition).toBe("processed");
  });

  it("composition root returns null when unbound, ports when bound", () => {
    expect(createMessagingPorts({})).toBeNull();
    expect(
      createMessagingPorts({ SCREENER_EVENTS: { send: async () => {} } })
    ).not.toBeNull();
    expect(
      createMessagingPorts({ SCREENER_EVENTS: { nope: true } })
    ).toBeNull();
  });
});

describe("screener event envelope translators", () => {
  const event: ScreenerEvent = {
    type: "screener.completed",
    timestamp: "2026-10-26T12:00:00.000Z",
    deliveryId: "del-42",
    sector: "Technology",
    totalScanned: 10,
    matchedCount: 2,
    opportunities: [],
  };

  it("round-trips a screener event with a stable idempotency anchor", () => {
    const env1 = toScreenerEnvelope(event, "svc-background");
    const env2 = toScreenerEnvelope(event, "svc-background");
    expect(env1.id).toBe(env2.id);
    expect(env1.type).toBe("screener.completed");
    expect(env1.correlationid).toBe("del-42");
    expect(env1.source).toBe("scheduled-tasks");
    expect(env1.stage).toBe("deliver");
    expect(env1.subject).toBe("del-42");
    const back = fromScreenerEnvelope(env1);
    expect(back?.event).toEqual(event);
    expect(back?.ownerLogin).toBe("svc-background");
  });

  it("subject is omitted when the event carries no delivery id", () => {
    const env = toScreenerEnvelope({ ...event, deliveryId: undefined });
    expect(env.subject).toBeUndefined();
    expect(env.id).toBe(`screener-event:screener.completed:${event.timestamp}`);
  });

  it("source records the trigger source for audit (trigger-agnostic execution)", () => {
    expect(toScreenerEnvelope(event, undefined, "ux-manual").source).toBe(
      "ux-manual"
    );
    expect(toScreenerEnvelope(event).source).toBe("scheduled-tasks");
  });

  it("rejects payloads that are not screener events", () => {
    expect(fromScreenerEnvelope(envelope())).toBeNull();
    expect(
      fromScreenerEnvelope(
        envelope({ data: { event: { type: "nope" } } })
      )
    ).toBeNull();
    expect(
      fromScreenerEnvelope(
        envelope({ data: { event: { type: "screener.completed" } } })
      )
    ).toBeNull();
  });
});

describe("screener queue consumer handler", () => {
  const event: ScreenerEvent = {
    type: "screener.completed",
    timestamp: "2026-10-26T12:00:00.000Z",
    deliveryId: "del-7",
    sector: "Technology",
    totalScanned: 5,
    matchedCount: 1,
    opportunities: [],
  };

  it("delivers under the payload owner without needing a service login", async () => {
    const delivered: Array<{ userLogin: string }> = [];
    const handler = createScreenerQueueHandler({
      env: {} as never,
      resolveUserLogin: () => null,
      deliver: async (_e, userLogin) => {
        delivered.push({ userLogin });
      },
    });
    const outcome = await handler(toScreenerEnvelope(event, "owner-login"));
    expect(outcome).toBe("processed");
    expect(delivered).toEqual([{ userLogin: "owner-login" }]);
  });

  it("refuses to dispatch with no identity (retry, never a fabricated login)", async () => {
    let calls = 0;
    const handler = createScreenerQueueHandler({
      env: {} as never,
      resolveUserLogin: () => null,
      deliver: async () => {
        calls += 1;
      },
    });
    const outcome = await handler(toScreenerEnvelope(event));
    expect(outcome).toBe("retry");
    expect(calls).toBe(0);
  });

  it("drops undecodable envelopes without calling deliver", async () => {
    let calls = 0;
    const handler = createScreenerQueueHandler({
      env: {} as never,
      resolveUserLogin: () => "svc-background",
      deliver: async () => {
        calls += 1;
      },
    });
    expect(await handler(envelope())).toBe("drop");
    expect(calls).toBe(0);
  });
});

describe("broadcast (pub/sub) conformance", () => {
  function subscriberSemantics(
    name: string,
    makePorts: () => MessagingPorts
  ) {
    describe(name, () => {
      it("one handler per (subscriber, type); second registration replaces the first", async () => {
        const ports = makePorts();
        const first: string[] = [];
        const second: string[] = [];
        ports.subscriber.subscribe("delivery", "screener.completed", async () => {
          first.push("x");
          return "processed";
        });
        ports.subscriber.subscribe("delivery", "screener.completed", async () => {
          second.push("x");
          return "processed";
        });
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("processed");
        expect(first).toHaveLength(0);
        expect(second).toHaveLength(1);
      });

      it("unsubscribe removes only the current handler", async () => {
        const ports = makePorts();
        const calls: string[] = [];
        const off1 = ports.subscriber.subscribe(
          "delivery",
          "screener.completed",
          async () => {
            calls.push("first");
            return "processed";
          }
        );
        ports.subscriber.subscribe(
          "delivery",
          "screener.completed",
          async () => {
            calls.push("second");
            return "processed";
          }
        );
        off1(); // stale: must not remove the replacement
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("processed");
        expect(calls).toEqual(["second"]);
      });

      it("dispatch with no handler is a drop; duplicate dispatch is a drop, not a reprocess", async () => {
        const ports = makePorts();
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("drop");
        let calls = 0;
        ports.subscriber.subscribe(
          "delivery",
          "screener.completed",
          async () => {
            calls += 1;
            return "processed";
          }
        );
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("processed");
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("drop");
        expect(calls).toBe(1);
      });

      it("a handler throw is a retry, and the retry may then process", async () => {
        const ports = makePorts();
        let calls = 0;
        ports.subscriber.subscribe(
          "delivery",
          "screener.completed",
          async () => {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return "processed";
          }
        );
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("retry");
        expect(
          await ports.subscriber.dispatch("delivery", envelope())
        ).toBe("processed");
        expect(calls).toBe(2);
      });
    });
  }

  subscriberSemantics("in-memory adapter", () => {
    const adapter = new InMemoryMessagingAdapter();
    return {
      producer: adapter,
      consumer: adapter,
      publisher: adapter,
      subscriber: adapter,
    };
  });

  subscriberSemantics("provider adapter", () => {
    const adapter = new CfQueueMessagingAdapter({
      send: async () => {},
    });
    return {
      producer: adapter,
      consumer: adapter,
      publisher: adapter,
      subscriber: adapter,
    };
  });

  it("in-memory publish fans out immediately with per-subscriber dedup", async () => {
    const adapter = new InMemoryMessagingAdapter();
    const delivery: string[] = [];
    const telemetry: string[] = [];
    adapter.subscribe("delivery", "screener.completed", async (e) => {
      delivery.push(e.id);
      return "processed";
    });
    adapter.subscribe("telemetry", "screener.completed", async (e) => {
      telemetry.push(e.id);
      return "processed";
    });
    const first = await adapter.publish(envelope());
    expect(first.deliveredTo.sort()).toEqual(["delivery", "telemetry"]);
    expect(first.failedTo).toEqual([]);
    const second = await adapter.publish(envelope());
    // Both subscribers already saw this id: neither takes it again.
    expect(second.deliveredTo).toEqual([]);
    expect(second.failedTo).toEqual([]);
    expect(delivery).toEqual(["evt-1"]);
    expect(telemetry).toEqual(["evt-1"]);
  });

  it("in-memory publish reports a retrying subscriber as failed, a refusing one as neither", async () => {
    const adapter = new InMemoryMessagingAdapter();
    adapter.subscribe("delivery", "screener.completed", async () => "retry");
    adapter.subscribe("telemetry", "screener.completed", async () => "drop");
    const report = await adapter.publish(envelope());
    expect(report.deliveredTo).toEqual([]);
    expect(report.failedTo).toEqual(["delivery"]);
  });

  it("provider publish fans out to one queue per subscriber, never a single collapsed consumer", async () => {
    const deliverySent: unknown[] = [];
    const telemetrySent: unknown[] = [];
    const adapter = new CfQueueMessagingAdapter(
      { send: async () => {} },
      {
        subscribers: {
          delivery: {
            send: async (body: unknown) => {
              deliverySent.push(body);
            },
          },
          telemetry: {
            send: async (body: unknown) => {
              telemetrySent.push(body);
            },
          },
        },
      }
    );
    const report = await adapter.publish(envelope());
    expect(report.deliveredTo.sort()).toEqual(["delivery", "telemetry"]);
    expect(report.failedTo).toEqual([]);
    expect((deliverySent as MessageEnvelope[]).map((b) => b.id)).toEqual([
      "evt-1",
    ]);
    expect((telemetrySent as MessageEnvelope[]).map((b) => b.id)).toEqual([
      "evt-1",
    ]);
  });

  it("provider publish with zero subscribers delivers to nobody; a failing subscriber is failedTo", async () => {
    const empty = new CfQueueMessagingAdapter({ send: async () => {} });
    expect(await empty.publish(envelope())).toEqual({
      deliveredTo: [],
      failedTo: [],
    });
    const partial = new CfQueueMessagingAdapter(
      { send: async () => {} },
      {
        subscribers: {
          broken: {
            send: async () => {
              throw new Error("queue down");
            },
          },
        },
      }
    );
    expect(await partial.publish(envelope())).toEqual({
      deliveredTo: [],
      failedTo: ["broken"],
    });
  });

  it("subscriber batch bridge maps retry to retry, everything else to ack, with shared dedup", async () => {
    const handlers: SubscriberHandlers = new Map([
      [
        "delivery",
        new Map([
          [
            "screener.completed",
            async (e) => {
              if (e.id === "retry-me") return "retry" as const;
              return "processed" as const;
            },
          ],
        ]),
      ],
    ]);
    const seen = new Set<string>();
    const acks: unknown[] = [];
    const retries: unknown[] = [];
    const mkMsg = (body: unknown) => ({
      body,
      ack: () => {
        acks.push(body);
      },
      retry: () => {
        retries.push(body);
      },
    });
    const batch = {
      queue: "screener-events-delivery",
      messages: [
        mkMsg(envelope({ id: "ok-1" })),
        mkMsg(envelope({ id: "retry-me" })),
        mkMsg(envelope({ id: "ok-1" })), // duplicate within shared seen
        mkMsg({ nope: true }), // undecodable
        mkMsg(envelope({ id: "other", type: "no.handler" })),
      ],
    };
    await dispatchSubscriberBatch(batch, "delivery", handlers, seen);
    expect(acks).toHaveLength(4); // ok-1, duplicate, invalid, no-handler
    expect(retries).toHaveLength(1);
    expect((retries[0] as MessageEnvelope).id).toBe("retry-me");
  });
});

describe("claim-check payload discipline (screener.md §8.2)", () => {
  it("an envelope over the serialized ceiling is invalid at every boundary", async () => {
    const huge = envelope({ data: { blob: "x".repeat(200_000) } });
    expect(MAX_ENVELOPE_BYTES).toBe(128 * 1024);
    expect(isMessageEnvelope(huge)).toBe(false);
    const adapter = new InMemoryMessagingAdapter();
    await expect(adapter.send(huge)).rejects.toMatchObject({
      code: "invalid_envelope",
    });
    await expect(adapter.publish(huge)).rejects.toMatchObject({
      code: "invalid_envelope",
    });
    let calls = 0;
    const report = await adapter.consume([huge], async () => {
      calls += 1;
      return "processed";
    });
    expect(calls).toBe(0);
    expect(report.results).toEqual([
      { id: null, disposition: "invalid" },
    ]);
  });

  it("a just-under-ceiling envelope still passes", () => {
    expect(
      isMessageEnvelope(envelope({ data: { blob: "x".repeat(100_000) } }))
    ).toBe(true);
  });
});

describe("composition root with broadcast wiring", () => {
  it("wires the delivery subscriber queue into publish fan-out", async () => {
    const deliverySent: unknown[] = [];
    const ports = createMessagingPorts({
      SCREENER_EVENTS: { send: async () => {} },
      SCREENER_EVENTS_DELIVERY: {
        send: async (body: unknown) => {
          deliverySent.push(body);
        },
      },
    });
    expect(ports).not.toBeNull();
    const report = await ports!.publisher.publish(envelope());
    expect(report.deliveredTo).toEqual(["delivery"]);
    expect((deliverySent as MessageEnvelope[]).map((b) => b.id)).toEqual([
      "evt-1",
    ]);
  });

  it("a malformed delivery binding fans out to nobody instead of throwing", async () => {
    const ports = createMessagingPorts({
      SCREENER_EVENTS: { send: async () => {} },
      SCREENER_EVENTS_DELIVERY: { nope: true },
    });
    expect(ports).not.toBeNull();
    const report = await ports!.publisher.publish(envelope());
    expect(report).toEqual({ deliveredTo: [], failedTo: [] });
  });
});

describe("port purity (provider-neutral domain surface)", () => {
  const read = (rel: string) =>
    readFileSync(resolve(__dirname, "..", rel), "utf8");
  const noProviderConcepts = (src: string) => {
    expect(src.toLowerCase()).not.toContain("cloudflare");
    expect(src).not.toContain("Queue<");
    expect(src).not.toContain(".ack(");
    expect(src).not.toContain(".retry(");
  };

  it("port, translators, consumer handler, and composition root carry no provider concepts", () => {
    for (const f of [
      "src/messaging/messagingPorts.ts",
      "src/messaging/screenerEventEnvelope.ts",
      "src/messaging/screenerQueueConsumer.ts",
      // Issue #2544 — the step-1 work-queue consumer handler joins
      // the purity list with the delivery consumer handler.
      "src/messaging/screenerEventsConsumer.ts",
      "src/messaging/createMessagingPorts.ts",
      "src/messaging/inMemoryMessagingAdapter.ts",
    ]) {
      noProviderConcepts(read(f));
    }
  });

  it("domain call sites never name the provider binding", () => {
    expect(read("src/services/scheduledTasks.ts")).not.toContain(
      "SCREENER_EVENTS"
    );
  });
});
