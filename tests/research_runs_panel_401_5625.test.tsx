/** @vitest-environment jsdom */

/**
 * Issue #5625 — "Run research now" must never show a JSON parser error.
 *
 * The panel used to call `res.json()` before checking `res.ok`. A bare-text
 * 401 from the `/api/*` forwarder made the parser's message the user-visible
 * failure ("Unexpected token 'U', "Unauthorized" is not valid JSON"). The
 * panel now reads every response through one guarded helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/options/csrf", () => ({ csrfHeaders: () => ({}) }));

const state = vi.hoisted(() => ({
  runResponse: null as Response | null,
  requests: [] as string[],
}));

import { ResearchRunsPanel } from "../src/client/options/ResearchRunsPanel";

function stubFetch() {
  vi.stubGlobal("fetch", async (url: string) => {
    state.requests.push(String(url));
    if (String(url).includes("/api/research/run")) {
      return state.runResponse ?? new Response("Unauthorized", { status: 401 });
    }
    if (String(url).includes("/api/research/latest")) {
      return new Response(JSON.stringify({ latest: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("/api/research/history")) {
      return new Response(JSON.stringify({ history: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("/api/research/settings")) {
      return new Response(JSON.stringify({ config: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

let mounted: Root | null = null;

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<ResearchRunsPanel activeEnv="TEST" userLogin="trader1" />);
  });
  await flush();
  mounted = root;
  return container;
}

function clickButton(container: HTMLElement, text: string) {
  const el = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  state.requests = [];
  state.runResponse = new Response("Unauthorized", { status: 401 });
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.unmount());
    mounted = null;
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Issue #5625 — Run research now on a plain-text 401", () => {
  it("states the session problem instead of the parser error", async () => {
    const container = await render();

    await act(async () => {
      clickButton(container, "Run research now").click();
    });
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("session has expired");
    expect(text).not.toContain("Unexpected token");
  });

  it("states a JSON 401 the same way", async () => {
    state.runResponse = new Response(
      JSON.stringify({
        code: "UNAUTHORIZED",
        error: "Unauthorized: sign in again — your session is missing or has expired.",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );

    const container = await render();
    await act(async () => {
      clickButton(container, "Run research now").click();
    });
    await flush();

    expect(container.textContent ?? "").toContain("session has expired");
  });

  it("names a non-JSON server failure as HTTP status plus its first line", async () => {
    state.runResponse = new Response("<html>Bad gateway</html>", { status: 502 });

    const container = await render();
    await act(async () => {
      clickButton(container, "Run research now").click();
    });
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("HTTP 502");
    expect(text).not.toContain("Unexpected token");
  });

  it("polls 202 async-job responses from POST /api/research/run instead of showing Failed: unknown error (#5721)", async () => {
    const mockReport = {
      runId: "run_202",
      trigger: "manual",
      createdAt: "2026-11-18T23:00:00Z",
      rulesVersion: "v1",
      summary: "Research complete",
      ideas: [],
      watchlist: [],
      rejected: [],
      stats: { qualified: 0, watchlist: 0, rejected: 0, unverified: 0, durationMs: 120 },
      configSnapshot: {},
    };
    vi.stubGlobal("fetch", async (url: string) => {
      state.requests.push(String(url));
      if (String(url).includes("/api/research/run")) {
        return new Response(
          JSON.stringify({ jobId: "job-123", status: "queued", statusUrl: "/api/jobs/job-123" }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("/api/jobs/job-123")) {
        return new Response(
          JSON.stringify({
            jobId: "job-123",
            status: "completed",
            capability: "http.request",
            responseStatus: 200,
            result: {
              body: JSON.stringify({ success: true, reportId: "rep_202", report: mockReport }),
              headers: { "content-type": "application/json" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ config: {}, latest: null, history: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const container = await render();
    await act(async () => {
      clickButton(container, "Run research now").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await flush();

    const text = container.textContent ?? "";
    expect(state.requests).toContain("/api/jobs/job-123");
    expect(text).toContain("Done — canonical report rep_202 stored.");
    expect(text).not.toContain("unknown error");
  });
});
