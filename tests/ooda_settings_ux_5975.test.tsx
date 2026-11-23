/** @vitest-environment jsdom */

/**
 * #5975 UX slice (issue #6289) — the OODA settings page manages and displays the
 * one execution configuration.
 *
 * Pins, in order:
 *  S1  the served execution group is built from the declaring constants
 *      (`RESEARCH_STAGE_KINDS`, `EXECUTION_MODE_AXES`, the venue catalogue),
 *      never from a client copy;
 *  S2  stored wins over the deployment default per stage AND per axis, and
 *      every mode names its source (stored / deployment / job);
 *  S3  a broken deployment default is reported beside the read, not thrown —
 *      the page still opens and the stored map still governs;
 *  S4  `GET /research/settings` serves it; `POST` still refuses an unknown
 *      stage by name through the same endpoint (one store, one validator);
 *  C1  the free-text Broker/Mode boxes are gone: two Selects offer only the
 *      catalogue plus an explicit tenant default, and the effective venue is
 *      stated on the page;
 *  C2  the stage-mode editor renders six stages x four axes against the served
 *      lists, and one save posts `stageModes` with the empty axes omitted
 *      (empty = inherit);
 *  C3  a server refusal is rendered verbatim and nothing is claimed saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import {
  EXECUTION_MODE_AXES,
  RESEARCH_STAGE_KINDS,
  type ResearchConfig,
} from "../src/config/researchJobConfig";
import { ROUTED_BROKER_IDS } from "../src/trading";
import { RESEARCH_VENUE_MODES } from "../src/services/researchVenue";
import { describeResearchExecution } from "../src/services/researchExecutionView";
import { RESEARCH_CONFIG_DEFAULTS, ResearchConfigService } from "../src/services/researchConfig";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/options/csrf", () => ({ csrfHeaders: () => ({}) }));

const storedConfig = (over: Partial<ResearchConfig> = {}): ResearchConfig => ({
  ...RESEARCH_CONFIG_DEFAULTS,
  ...over,
});

describe("#5975 UX slice — the served execution description (#6289)", () => {
  it("S1: builds the stage, axis and venue lists from the declaring constants", () => {
    const execution = describeResearchExecution({}, storedConfig());
    expect(execution.stages).toEqual([...RESEARCH_STAGE_KINDS]);
    expect(execution.axes).toEqual([...EXECUTION_MODE_AXES]);
    expect(execution.venues.brokers).toEqual([...ROUTED_BROKER_IDS]);
    expect(execution.venues.modes).toEqual([...RESEARCH_VENUE_MODES]);
    // The tenant default is the resolver's own answer, not a client literal.
    expect(execution.venues.brokers).toContain(execution.venues.defaultBrokerId);
    expect(execution.venues.defaultMode).toBe("paper");
    expect(execution.venues.defaultsError).toBeNull();
  });

  it("S2: stored wins per stage and per axis, and every mode names its source", () => {
    const env = { RESEARCH_STAGE_MODES: JSON.stringify({ analyze: { pacing: "online" }, deliver: { delivery: "env" } }) };
    const execution = describeResearchExecution(
      env,
      storedConfig({ stageModes: { analyze: { pacing: "batch" }, generate: { shape: "sharded" } } }),
    );
    expect(execution.effectiveModes.analyze?.pacing).toBe("batch");
    expect(execution.effectiveModes.deliver?.delivery).toBe("env");
    expect(execution.effectiveModes.generate?.shape).toBe("sharded");
    // Sources: stored where the setting names the axis, deployment where only
    // the env names it, job where neither does — never guessed.
    expect(execution.modeSources.analyze?.pacing).toBe("stored");
    expect(execution.modeSources.deliver?.delivery).toBe("deployment");
    expect(execution.modeSources.feed).toBeUndefined();
    expect(execution.modeSources.generate?.shape).toBe("stored");
    // The deployment map itself is unchanged by the merge.
    expect(execution.deploymentModes.analyze?.pacing).toBe("online");
    expect(execution.deploymentErrors).toEqual([]);
  });

  it("S3: a broken deployment default is reported beside the read, never thrown", () => {
    const execution = describeResearchExecution(
      { RESEARCH_STAGE_MODES: "{not json" },
      storedConfig({ stageModes: { analyze: { pacing: "online" } } }),
    );
    expect(execution.deploymentErrors).toHaveLength(1);
    expect(execution.deploymentErrors[0]).toMatch(/RESEARCH_STAGE_MODES/);
    expect(execution.deploymentModes).toEqual({});
    expect(execution.effectiveModes.analyze?.pacing).toBe("online");
  });
});

function routeCtx(env: Record<string, unknown> = {}) {
  // The real service over an in-memory store: the POST refusal below is the
  // shipped validator's, not a stub's.
  const settings = new Map<string, string>();
  const service = new ResearchConfigService({
    get: (key) => settings.get(key) ?? null,
    set: (key, value) => void settings.set(key, value),
  });
  const agent = {
    getResearchConfig: vi.fn(async () => service.load()),
    saveConfig: vi.fn(async (patch: Partial<ResearchConfig>) => service.save(patch)),
  };
  const ctx = {
    getScreenerAgent: vi.fn(() => null),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => agent),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => ({}) as never),
    readSettingRaw: vi.fn(() => null),
    writeSetting: vi.fn(),
    env,
  } as unknown as ScreenerResearchRouteContext;
  return { ctx, agent };
}

async function call(ctx: ScreenerResearchRouteContext, method: string, path: string, body?: unknown) {
  const res = await handleScreenerResearchRoutes(
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        "x-user-login": "alice",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    new URL(`https://agent.internal${path}`),
    path,
    "s1",
    ctx,
  );
  if (!res) throw new Error(`no route matched ${method} ${path}`);
  return { res, data: (await res.json()) as any };
}

describe("#5975 UX slice — the settings endpoint serves the execution group (#6289)", () => {
  it("S4: GET serves the group beside the config, and POST still refuses an unknown stage by name", async () => {
    const { ctx } = routeCtx({ RESEARCH_STAGE_MODES: JSON.stringify({ analyze: { pacing: "online" } }) });
    const get = await call(ctx, "GET", "/research/settings");
    expect(get.res.status).toBe(200);
    expect(get.data.config).toBeTruthy();
    expect(get.data.execution.stages).toEqual([...RESEARCH_STAGE_KINDS]);
    expect(get.data.execution.effectiveModes.analyze.pacing).toBe("online");

    const bad = await call(ctx, "POST", "/research/settings", { stageModes: { nonsense: { pacing: "x" } } });
    expect(bad.res.status).toBe(400);
    expect(String(bad.data.errors?.[0] ?? "")).toMatch(/nonsense/);
  });
});

// ---------------------------------------------------------------------------
// The panel: the venue pair is an enum, the stage modes are editable, and a
// refusal is rendered. Rendered against a stub fetch that serves the same
// execution group the route now returns.
// ---------------------------------------------------------------------------

const panelState = vi.hoisted(() => ({
  settings: null as any,
  postBody: null as string | null,
  postResponse: null as Response | null,
}));

function stubFetch() {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const href = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (href.includes("/api/research/settings")) {
      if (init?.method === "POST") {
        panelState.postBody = String(init.body ?? "");
        return (
          panelState.postResponse ??
          json({ config: panelState.settings?.config ?? {}, errors: [] })
        );
      }
      return json(panelState.settings ?? { config: {} });
    }
    if (href.includes("/api/research/latest")) return json({ latest: null });
    if (href.includes("/api/research/history")) return json({ history: [] });
    return json({});
  });
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

let mounted: Root | null = null;

async function renderPanel() {
  const { ResearchRunsPanel } = await import("../src/client/options/ResearchRunsPanel");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<ResearchRunsPanel activeEnv="TEST" userLogin="alice" />);
  });
  await flush();
  mounted = root;
  return container;
}

/** The execution editor lives in the settings card: open it as a user would. */
async function openSettings(container: HTMLElement) {
  const toggle = [...container.querySelectorAll("button")].find((b) =>
    /edit filters/i.test(b.textContent ?? ""),
  );
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush(2);
}

function executionFixture() {
  return describeResearchExecution(
    { RESEARCH_STAGE_MODES: JSON.stringify({ analyze: { pacing: "online" } }) },
    storedConfig({ stageModes: { generate: { shape: "sharded" } } }),
  );
}

describe("#5975 UX slice — the panel (#6289)", () => {
  beforeEach(() => {
    stubFetch();
    panelState.postBody = null;
    panelState.postResponse = null;
    panelState.settings = {
      config: { ...storedConfig({ stageModes: { generate: { shape: "sharded" } } }) },
      execution: executionFixture(),
      universes: ["NASDAQ100", "SP500"],
    };
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.unmount());
      mounted = null;
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("C1: the venue pair is an enum with an explicit tenant default, and the effective venue is stated", async () => {
    const container = await renderPanel();
    // The free-text boxes are gone.
    expect(container.querySelector('input[placeholder="Broker (default configured)"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Mode (paper / live)"]')).toBeNull();

    const broker = container.querySelector('select[aria-label="Broker / venue"]') as HTMLSelectElement | null;
    const mode = container.querySelector('select[aria-label="Mode"]') as HTMLSelectElement | null;
    expect(broker).not.toBeNull();
    expect(mode).not.toBeNull();
    const brokerValues = [...broker!.options].map((o) => o.value);
    expect(brokerValues).toEqual(["", ...ROUTED_BROKER_IDS]);
    const modeValues = [...mode!.options].map((o) => o.value);
    expect(modeValues).toEqual(["", ...RESEARCH_VENUE_MODES]);
    expect(container.textContent ?? "").toMatch(/Effective venue/i);
    expect(container.textContent ?? "").toMatch(/tenant default/i);
  });

  it("C2: the editor renders every stage and axis from the served lists, and one save posts only the set axes", async () => {
    const container = await renderPanel();
    await openSettings(container);
    for (const stage of RESEARCH_STAGE_KINDS) {
      for (const axis of EXECUTION_MODE_AXES) {
        const input = container.querySelector(
          `input[aria-label="${stage}: ${axis} mode"]`,
        ) as HTMLInputElement | null;
        expect(input, `${stage}:${axis}`).not.toBeNull();
      }
    }
    // A stored value is shown in its box; an untouched axis stays empty (= inherit).
    const stored = container.querySelector('input[aria-label="generate: shape mode"]') as HTMLInputElement;
    expect(stored.value).toBe("sharded");
    expect((container.querySelector('input[aria-label="feed: pacing mode"]') as HTMLInputElement).value).toBe("");

    // Type an override on one axis, then save once.
    const analyze = container.querySelector('input[aria-label="analyze: pacing mode"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(analyze, "batch");
      analyze.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(panelState.postBody).not.toBeNull();
    const posted = JSON.parse(panelState.postBody!);
    expect(posted.stageModes).toEqual({
      analyze: { pacing: "batch" },
      generate: { shape: "sharded" },
    });
    // Empty axes are omitted: an empty value means inherit, never "".
    for (const axes of Object.values(posted.stageModes as Record<string, Record<string, string>>)) {
      for (const value of Object.values(axes)) expect(value).not.toBe("");
    }
  });

  it("C3: a validation refusal is rendered verbatim and nothing is claimed saved", async () => {
    panelState.postResponse = new Response(
      JSON.stringify({
        config: { ...storedConfig() },
        errors: ['Unknown research stage "nonsense" in stageModes. Expected one of: feed, enrich, analyze, generate, deliver, evaluate'],
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const container = await renderPanel();
    await openSettings(container);
    const save = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toMatch(/Unknown research stage "nonsense"/);
    expect(text).not.toMatch(/Saved — the next run embeds this filter snapshot/);
  });
});
