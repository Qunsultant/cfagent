/** @vitest-environment jsdom */
/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * sub-tab: the Observability tab + Archive view in the app.
 *
 * TDD Red first: the view helpers
 * (src/client/observabilityView.ts), the API module
 * (src/client/otelArchiveApi.ts), the panel
 * (src/client/OtelArchivePanel.tsx), the home
 * (src/client/ObservabilityHome.tsx), and the nav entries
 * (src/client/nav-config.json) do not exist yet — every test
 * below fails until the slice lands.
 *
 * The view is a RAW file browser, not a dashboard: it lists the
 * archived OTLP JSONL objects (date, signal, size) with a link
 * to view/download each object's raw content, carries a plain
 * description of what the archive is, and states plainly when
 * R2 archiving is off instead of showing an empty list.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/otelArchiveApi", () => ({
  fetchOtelArchiveList: vi.fn(),
  otelArchiveObjectUrl: (key: string) =>
    `/api/otel/v1/archive/object?key=${encodeURIComponent(key)}`,
  formatArchiveBytes: (sizeBytes: number) => {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  },
}));

import { ObservabilityHome } from "../src/client/ObservabilityHome";
import { OtelArchivePanel, formatArchiveBytes } from "../src/client/OtelArchivePanel";
import { fetchOtelArchiveList } from "../src/client/otelArchiveApi";
import {
  OBSERVABILITY_VIEWS,
  OBSERVABILITY_VIEW_LABELS,
  normalizeObservabilityView,
  parseObservabilityDeepLink,
} from "../src/client/observabilityView";
import { DEFAULT_LEFT_NAV_CONFIG } from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import { getRoute } from "../src/client/routes";
import {
  DEEP_LINK_OVERRIDES,
  SURFACE_TAB_DEFS,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";

const mockedFetchOtelArchiveList = vi.mocked(fetchOtelArchiveList);

const LIST_RESPONSE = {
  archivingEnabled: true,
  objects: [
    {
      key: "otel-archive/2026-11-17/log-1.jsonl",
      date: "2026-11-17",
      signal: "logs" as const,
      sizeBytes: 1234,
      lines: 12,
    },
    {
      key: "otel-archive/2026-11-16/metric-1.jsonl",
      date: "2026-11-16",
      signal: "metrics" as const,
      sizeBytes: 99,
      lines: 1,
    },
  ],
  truncated: false,
  pageSize: 50,
  maxObjects: 500,
};

describe("5169 view: the Observability tab's views — Archive, Config, SLOs", () => {
  it("OBSERVABILITY_VIEWS lists archive, config, slo, labelled", () => {
    // S7 (#5086) adds the Config view; archive stays the default.
    // S5 (#5425) adds the SLO view; archive stays the default.
    expect([...OBSERVABILITY_VIEWS]).toEqual(["archive", "config", "slo"]);
    expect(OBSERVABILITY_VIEW_LABELS["archive"]).toBe("Archive");
    expect(OBSERVABILITY_VIEW_LABELS["config"]).toBe("Config");
    expect(OBSERVABILITY_VIEW_LABELS["slo"]).toBe("SLOs");
  });

  it("normalize/parse accept the three views and fall back to archive for unknown views", () => {
    expect(normalizeObservabilityView("archive")).toBe("archive");
    expect(normalizeObservabilityView("slo")).toBe("slo");
    expect(normalizeObservabilityView("bogus")).toBe("archive");
    expect(parseObservabilityDeepLink("?tab=observability&view=archive")).toEqual({
      view: "archive",
      tenantId: "primary",
    });
    expect(parseObservabilityDeepLink("?tab=observability&view=slo")).toEqual({
      view: "slo",
      tenantId: "primary",
    });
    expect(parseObservabilityDeepLink("?tab=observability&view=nope")).toEqual({
      view: "archive",
      tenantId: "primary",
    });
  });
});

describe("5169 nav: Observability is a Platform nav entry with an Archive sub-item", () => {
  it("the route exists, is a nav entry at navOrder 27, category Platform", () => {
    const route = getRoute("observability");
    expect(route).toBeDefined();
    expect(route!.category).toBe("Platform");
    expect(route!.navEntry).toBeDefined();
    expect(route!.navEntry!.navOrder).toBe(27);
    expect(route!.navEntry!.label).toBe("Observability");
    expect(route!.navGroup).toBe("observability");
  });

  it("the Platform section carries the Observability item with an Archive sub-item", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "observability");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(1);
    const sub = item!.subItems![0];
    expect(sub.id).toBe("archive");
    expect(sub.label).toBe("Archive");
    expect(sub.description).toBeTruthy();
    expect(sub.icon).toBeTruthy();
    expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    expect(NAV_ICON_MAP[item!.icon]).toBeDefined();
  });

  it("archive deep-links to ?tab=observability&view=archive and is a listed surface value", () => {
    expect(deepLinkForNavNode("observability", "archive")).toEqual({
      tab: "observability",
      view: "archive",
    });
    expect(deepLinkHrefForNavNode("observability", "archive")).toBe(
      "?tab=observability&view=archive",
    );
    expect(DEEP_LINK_OVERRIDES["observability:archive"]).toEqual({
      tab: "observability",
      view: "archive",
    });
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "observability");
    expect(surface).toBeDefined();
    expect([...surface!.values]).toEqual(["archive"]);
  });
});

describe("5169 panel: OtelArchivePanel renders the file browser", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
  }

  beforeEach(() => {
    mockedFetchOtelArchiveList.mockReset();
    window.history.pushState({}, "", "?tab=observability&view=archive");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
  });

  it("renders the plain description, the rows grouped by date, and view/download links", async () => {
    mockedFetchOtelArchiveList.mockResolvedValue(LIST_RESPONSE);
    await render(<OtelArchivePanel />);
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("raw OTLP JSONL");
    expect(text).toContain("file browser, not a dashboard");
    expect(text).toContain("2026-11-17");
    expect(text).toContain("2026-11-16");
    expect(text).toContain("logs");
    expect(text).toContain("metrics");
    const links = [...container.querySelectorAll("a")];
    const viewLink = links.find((a) =>
      (a.getAttribute("href") ?? "").includes("otel-archive%2F2026-11-17%2Flog-1.jsonl"),
    );
    expect(viewLink).toBeDefined();
    expect(viewLink!.getAttribute("target")).toBe("_blank");
    const downloadLink = links.find(
      (a) => a.getAttribute("download") === "log-1.jsonl",
    );
    expect(downloadLink).toBeDefined();
  });

  it("states plainly that archiving is off instead of showing an empty list", async () => {
    mockedFetchOtelArchiveList.mockResolvedValue({
      ...LIST_RESPONSE,
      archivingEnabled: false,
      objects: [],
    });
    await render(<OtelArchivePanel />);
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toMatch(/archiving is off/i);
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("renders an honest error state when the list fetch fails", async () => {
    mockedFetchOtelArchiveList.mockRejectedValue(new Error("boom"));
    await render(<OtelArchivePanel />);
    await act(async () => {});
    expect(container.textContent ?? "").toMatch(/could not be loaded/i);
  });

  it("formats sizes in bytes and kilobytes", () => {
    expect(formatArchiveBytes(99)).toBe("99 B");
    expect(formatArchiveBytes(1234)).toBe("1.2 KB");
  });
});

describe("5169 home: ObservabilityHome mounts the Archive panel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    mockedFetchOtelArchiveList.mockReset();
    mockedFetchOtelArchiveList.mockResolvedValue(LIST_RESPONSE);
    window.history.pushState({}, "", "?tab=observability&view=archive");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
  });

  it("renders the Observability title and the Archive tab with the panel", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ObservabilityHome />);
    });
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("Observability");
    expect(text).toContain("Archive");
    expect(text).toContain("2026-11-17");
  });
});
