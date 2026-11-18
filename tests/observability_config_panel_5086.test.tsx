/** @vitest-environment jsdom */
/**
 * Issue #5086 (S7, observability program #5080) — the Config
 * sub-tab: the message catalog + runtime config port in the
 * Observability tab (`?tab=observability&view=config`).
 *
 * The panel lists every overridable key with its effective
 * value and winning source, and the catalog with its codes
 * and severities. A platform admin edits a key by choosing a
 * new value + a required, audited reason and applying it;
 * clearing an override restores the deploy-time value. The
 * tests drive the panel against a mocked API module (a small
 * config: two keys + one catalog entry), and the view helpers
 * directly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/otelConfigApi", () => ({
  fetchOtelConfig: vi.fn(),
  applyOtelConfigOverride: vi.fn(),
  clearOtelConfigOverride: vi.fn(),
}));

import { ObservabilityHome } from "../src/client/ObservabilityHome";
import {
  OtelConfigPanel,
  formatEffectiveValue,
  parseOtelConfigDraft,
} from "../src/client/OtelConfigPanel";
import {
  fetchOtelConfig,
  applyOtelConfigOverride,
  clearOtelConfigOverride,
} from "../src/client/otelConfigApi";
import {
  OBSERVABILITY_VIEWS,
  OBSERVABILITY_VIEW_LABELS,
  normalizeObservabilityView,
  parseObservabilityDeepLink,
} from "../src/client/observabilityView";

const mockedFetchOtelConfig = vi.mocked(fetchOtelConfig);
const mockedApply = vi.mocked(applyOtelConfigOverride);
const mockedClear = vi.mocked(clearOtelConfigOverride);

const CONFIG_RESPONSE = {
  catalog: [
    {
      code: "OBS-1001",
      name: "otel.config.invalid",
      template: '{switch} unrecognized value at {source}; failing closed to "{fallback}"',
      severity: "warning" as const,
    },
  ],
  keys: [
    {
      key: "alerting.maxAlertsPerDay",
      kind: "positiveInt" as const,
      description: "Alerting free-tier guard: max alerts per day",
      envName: "OTEL_ALERTING_MAX_ALERTS_PER_DAY",
    },
    {
      key: "catalog.OBS-1001.severity",
      kind: "severity" as const,
      description: "Catalog severity override for OBS-1001 (otel.config.invalid)",
    },
  ],
  overrides: [],
  effective: {
    "alerting.maxAlertsPerDay": { value: 100, source: "file" },
    "catalog.OBS-1001.severity": { value: "warning", source: "catalog" },
  },
};

const CONFIG_WITH_OVERRIDE = {
  ...CONFIG_RESPONSE,
  overrides: [
    {
      key: "alerting.maxAlertsPerDay",
      value: 25,
      version: 2,
      updatedBy: "user-owner",
      updatedAtMs: 1795008000000,
      reason: "tighten the guard",
    },
  ],
  effective: {
    "alerting.maxAlertsPerDay": { value: 25, source: "runtime" },
    "catalog.OBS-1001.severity": { value: "warning", source: "catalog" },
  },
};

/** Sets a native input/select value the way React observes it. */
function setControlValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Finds a labeled control (Select / TextInput) by its label text. */
function controlForLabel(container: HTMLElement, labelText: string): HTMLElement | null {
  const label = [...container.querySelectorAll("label")].find(
    (el) => (el.textContent ?? "").trim() === labelText,
  );
  if (!label) return null;
  const id = label.getAttribute("for");
  if (!id) return null;
  return document.getElementById(id);
}

describe("5086 view: the Observability tab has a Config view", () => {
  it("lists config alongside archive, with its label, and falls back to archive for unknown views", () => {
    expect(OBSERVABILITY_VIEWS).toContain("config");
    expect(OBSERVABILITY_VIEW_LABELS.config).toBe("Config");
    expect(normalizeObservabilityView("config")).toBe("config");
    expect(normalizeObservabilityView("nope")).toBe("archive");
    expect(parseObservabilityDeepLink("?tab=observability&view=config").view).toBe("config");
    expect(parseObservabilityDeepLink("?tab=observability").view).toBe("archive");
  });
});

describe("5086 helpers: effective values and draft parsing", () => {
  it("formats booleans as on/off and numbers as-is", () => {
    expect(formatEffectiveValue(true)).toBe("on");
    expect(formatEffectiveValue(false)).toBe("off");
    expect(formatEffectiveValue(100)).toBe("100");
    expect(formatEffectiveValue("warning")).toBe("warning");
  });

  it("parses drafts per kind (booleans, numbers, strings) and rejects non-numbers", () => {
    expect(parseOtelConfigDraft("boolean", "true")).toBe(true);
    expect(parseOtelConfigDraft("boolean", "false")).toBe(false);
    expect(parseOtelConfigDraft("positiveInt", "25")).toBe(25);
    expect(parseOtelConfigDraft("ratio", "0.5")).toBe(0.5);
    expect(parseOtelConfigDraft("positiveInt", "abc")).toBeNull();
    expect(parseOtelConfigDraft("positiveInt", "")).toBeNull();
    expect(parseOtelConfigDraft("severity", "critical")).toBe("critical");
  });
});

describe("5086 panel: OtelConfigPanel renders keys + catalog", () => {
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
    mockedFetchOtelConfig.mockReset();
    mockedApply.mockReset();
    mockedClear.mockReset();
    window.history.pushState({}, "", "?tab=observability&view=config");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
  });

  it("renders the keys table with effective values + sources and the catalog table", async () => {
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_RESPONSE);
    await render(<OtelConfigPanel />);
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("config edit, not a code change");
    expect(text).toContain("alerting.maxAlertsPerDay");
    expect(text).toContain("100");
    expect(text).toContain("file");
    expect(text).toContain("OBS-1001");
    expect(text).toContain("otel.config.invalid");
    expect(text).toContain("warning");
  });

  it("renders an honest error state when the config fetch fails", async () => {
    mockedFetchOtelConfig.mockRejectedValue(new Error("boom"));
    await render(<OtelConfigPanel />);
    await act(async () => {});
    expect(container.textContent ?? "").toMatch(/could not be loaded/i);
  });

  it("renders the admin-only title for a 403 (platform-admins-only) error", async () => {
    mockedFetchOtelConfig.mockRejectedValue(
      new Error("OTel config is available to platform admins only"),
    );
    await render(<OtelConfigPanel />);
    await act(async () => {});
    expect(container.textContent ?? "").toMatch(/platform admins only/i);
  });

  it("shows the override (version, actor, reason) and a Clear button when one is set", async () => {
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_WITH_OVERRIDE);
    await render(<OtelConfigPanel />);
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("25");
    expect(text).toContain("runtime");
    expect(text).toContain("v2");
    expect(text).toContain("user-owner");
    expect(text).toContain("tighten the guard");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Clear override")).toBe(true);
  });

  it("applies a new value with its reason, then reloads", async () => {
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_RESPONSE);
    mockedApply.mockResolvedValue({
      record: {
        key: "alerting.maxAlertsPerDay",
        value: 25,
        version: 1,
        updatedBy: "user-owner",
        updatedAtMs: 1795008000000,
        reason: "tighten the guard",
      },
    });
    await render(<OtelConfigPanel />);
    await act(async () => {});

    const valueInput = controlForLabel(container, "New value for alerting.maxAlertsPerDay");
    const reasonInput = controlForLabel(container, "Reason for changing alerting.maxAlertsPerDay");
    expect(valueInput).not.toBeNull();
    expect(reasonInput).not.toBeNull();
    await act(async () => {
      setControlValue(valueInput as HTMLInputElement, "25");
      setControlValue(reasonInput as HTMLInputElement, "tighten the guard");
    });
    const cell = reasonInput!.closest("td") ?? reasonInput!.closest("div");
    const applyButton = [...(cell?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Apply",
    );
    expect(applyButton).toBeDefined();
    await act(async () => {
      applyButton!.click();
    });
    expect(mockedApply).toHaveBeenCalledWith("alerting.maxAlertsPerDay", 25, "tighten the guard");
    // A successful apply reloads the config.
    expect(mockedFetchOtelConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps Apply disabled until a reason is entered", async () => {
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_RESPONSE);
    await render(<OtelConfigPanel />);
    await act(async () => {});
    const reasonInput = controlForLabel(container, "Reason for changing alerting.maxAlertsPerDay");
    const cell = reasonInput!.closest("td") ?? reasonInput!.closest("div");
    const applyButton = [...(cell?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Apply",
    );
    expect(applyButton?.disabled).toBe(true);
  });

  it("clears an override with its reason, then reloads", async () => {
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_WITH_OVERRIDE);
    mockedClear.mockResolvedValue(undefined);
    await render(<OtelConfigPanel />);
    await act(async () => {});

    const reasonInput = controlForLabel(container, "Reason for changing alerting.maxAlertsPerDay");
    expect(reasonInput).not.toBeNull();
    await act(async () => {
      setControlValue(reasonInput as HTMLInputElement, "incident over");
    });
    const cell = reasonInput!.closest("td") ?? reasonInput!.closest("div");
    const clearButton = [...(cell?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Clear override",
    );
    expect(clearButton).toBeDefined();
    await act(async () => {
      clearButton!.click();
    });
    expect(mockedClear).toHaveBeenCalledWith("alerting.maxAlertsPerDay", "incident over");
    expect(mockedFetchOtelConfig).toHaveBeenCalledTimes(2);
  });
});

describe("5086 home: ObservabilityHome mounts the Config panel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    mockedFetchOtelConfig.mockReset();
    mockedFetchOtelConfig.mockResolvedValue(CONFIG_RESPONSE);
    window.history.pushState({}, "", "?tab=observability&view=config");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
  });

  it("renders the Observability title and the Config tab with the panel", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ObservabilityHome />);
    });
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("Observability");
    expect(text).toContain("Config");
    expect(text).toContain("alerting.maxAlertsPerDay");
    expect(text).toContain("OBS-1001");
  });
});
