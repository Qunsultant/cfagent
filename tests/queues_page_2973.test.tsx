/** @vitest-environment jsdom */
/**
 * Queues page (issue #2973, nav re-org slice 5).
 *
 * The Platform Queues page composes the existing queue surfaces —
 * async jobs, the dead-letter queue, trade approvals — without
 * reimplementing any of them. Pending review stays on the Review
 * page and must NOT appear here. The DLQ had no client UI before
 * this slice; these tests pin its first surface: listing, replay,
 * and the server-side operator gate rendered as a notice.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { QueuesPage } from "../src/client/QueuesPage";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

function jobRow(id: string, label: string, status: string) {
  return {
    jobId: id,
    capability: "test",
    label,
    status,
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
  };
}

function dlqRow(id: string, queue: string, reason: string) {
  return {
    id,
    queue,
    reason,
    messageId: `msg-${id}`,
    runId: null,
    unitId: null,
    actorLogin: null,
    subscriber: null,
    detail: null,
    createdAtMs: 1762176000000,
  };
}

function installFetch(opts: { dlqStatus?: number; dlqAfterReplay?: unknown[] } = {}) {
  let dlqRecords: unknown[] = [dlqRow("dlq-1", "screener-events", "no_handler"), dlqRow("dlq-2", "screener-events", "denied")];
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = undefined;
    }
    fetchCalls.push({ url, method, body });
    if (url === "/api/jobs?limit=30") {
      return { ok: true, status: 200, json: async () => ({ jobs: [jobRow("job-1", "Nightly screen", "completed"), jobRow("job-2", "Options scan", "failed")] }) } as Response;
    }
    if (url === "/api/broker/orders") {
      return { ok: true, status: 200, json: async () => ({ trades: [] }) } as Response;
    }
    if (url === "/api/ops/dlq/records") {
      if (opts.dlqStatus === 403) {
        return { ok: false, status: 403, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ records: dlqRecords }) } as Response;
    }
    if (url === "/api/ops/dlq/replay" && method === "POST") {
      dlqRecords = opts.dlqAfterReplay ?? [];
      return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  (globalThis as any).fetch = stub;
  return stub;
}

async function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueuesPage />);
  });
  // Let the mount-time fetches resolve.
  await act(async () => {});
}

beforeEach(() => {
  fetchCalls.length = 0;
  installFetch();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Queues page (issue #2973)", () => {
  it("renders all three queue sections and no pending-review section", async () => {
    await renderPage();
    const text = container!.textContent ?? "";
    expect(text).toContain("Async jobs");
    expect(text).toContain("Dead-letter queue");
    expect(text).toContain("Trade approvals");
    expect(text).not.toContain("Held deliveries");
  });

  it("shows async jobs from the jobs endpoint", async () => {
    await renderPage();
    const text = container!.textContent ?? "";
    expect(text).toContain("Nightly screen");
    expect(text).toContain("Options scan");
    expect(fetchCalls.some((c) => c.url === "/api/jobs?limit=30")).toBe(true);
  });

  it("lists dead-letter records with queue, reason, and a replay action", async () => {
    await renderPage();
    const text = container!.textContent ?? "";
    expect(text).toContain("screener-events");
    expect(text).toContain("no_handler");
    expect(text).toContain("denied");
    const replayButtons = Array.from(container!.querySelectorAll("button")).filter(
      (b) => b.textContent === "Replay",
    );
    expect(replayButtons).toHaveLength(2);
  });

  it("replays a record, posts its id, and refreshes the list", async () => {
    await renderPage();
    const replayButtons = Array.from(container!.querySelectorAll("button")).filter(
      (b) => b.textContent === "Replay",
    );
    await act(async () => {
      replayButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    const replayCall = fetchCalls.find((c) => c.url === "/api/ops/dlq/replay");
    expect(replayCall).toBeDefined();
    expect(replayCall!.method).toBe("POST");
    expect(replayCall!.body).toEqual({ recordId: "dlq-1" });
    const text = container!.textContent ?? "";
    expect(text).toContain("Record replayed to its source queue.");
    expect(text).toContain("No unreplayed records");
  });

  it("renders the operator gate as a notice when listing is forbidden", async () => {
    (globalThis as any).fetch = undefined;
    installFetch({ dlqStatus: 403 });
    await renderPage();
    const text = container!.textContent ?? "";
    expect(text).toContain("Operator access required");
    expect(text).not.toContain("screener-events");
  });
});
