/**
 * Phase 5 Slice 1 (#2000) — structural pin on the queue bindings.
 *
 * Both consumers keep max_retries: 2 and a dead_letter_queue;
 * both DLQ queues keep producer bindings (the DLQ queues
 * themselves are never replay targets — replay re-drives to
 * the source queues, which also keep producer bindings).
 * This pin is independent of the #2544 consumer-config pin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

describe("DLQ binding structural pin (#2000 slice 1)", () => {
  it("both consumers keep max_retries 2 + dead_letter_queue; DLQ and source queues keep producer bindings", () => {
    const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
      queues?: { producers?: Array<{ queue: string }>; consumers?: Array<{ queue: string; max_retries?: number; dead_letter_queue?: string }> };
    };
    const consumers = new Map((wrangler.queues?.consumers ?? []).map((c) => [c.queue, c]));
    const producers = new Set((wrangler.queues?.producers ?? []).map((p) => p.queue));
    const screener = consumers.get("screener-events");
    const delivery = consumers.get("screener-events-delivery");
    expect(screener?.max_retries).toBe(2);
    expect(screener?.dead_letter_queue).toBe("screener-events-dlq");
    expect(delivery?.max_retries).toBe(2);
    expect(delivery?.dead_letter_queue).toBe("screener-events-delivery-dlq");
    for (const q of ["screener-events", "screener-events-delivery", "screener-events-dlq", "screener-events-delivery-dlq"]) {
      expect(producers.has(q)).toBe(true);
    }
  });
});
