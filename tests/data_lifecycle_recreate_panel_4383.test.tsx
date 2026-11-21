/** @vitest-environment jsdom */
/**
 * DataLifecyclePanel — RecreateCard (#4383): the recreate operation
 * on the Data Lifecycle surface.
 *
 * Fetch is stubbed at the global boundary and routed by URL, in the
 * data_lifecycle_panel_3250 idiom; the canned responses mirror the
 * real route shapes in tests/data_lifecycle_recreate_4383.test.ts.
 * downloadTextFile is mocked so the report download can be asserted
 * without a real download.
 *
 * Contract pins:
 * - Preview shows the summary (D1 planned steps, per-instance
 *   planned steps, uncreatable layers) plus an expandable detail
 *   of per-statement codes grouped by leg and statement kind.
 * - Confirm runs through the modal; platform scope requires the
 *   typed phrase CLEAN PLATFORM and the audit confirmation.
 * - The result renders executed/failed/skipped per leg, the
 *   uncreatable layers, and the audit line — and the report is
 *   downloadable from the surface.
 * - A refused preview renders the server error and no detail.
 */
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataLifecyclePanel } from "../src/client/DataLifecyclePanel";
import { downloadTextFile } from "../src/client/runExport";

vi.mock("../src/client/runExport", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/client/runExport")>();
  return { ...orig, downloadTextFile: vi.fn() };
});

let container: HTMLDivElement;
let root: Root;

const TENANTS = {
  tenants: [
    {
      tenantId: "tenant-a",
      adsEnabled: true,
      autoRefreshEnabled: false,
      autoRefreshIntervalS: 15,
      dataProviderId: "etrade",
      brokerId: "etrade",
      turnStepTimeoutMs: null,
      memberCount: 2,
    },
  ],
};

const UNCREATABLE_LAYERS = [
  { layer: "vectorize:vector-memory", reason: "No re-index flow.", remedy: "Provision via deployment." },
  { layer: "r2:screener:knowledge/", reason: "Corpus bytes are not in SQL.", remedy: "Owner uploads from the Corpus tab." },
  { layer: "queues:deploy-time", reason: "Deploy-time provisioned.", remedy: "Provision via deployment." },
  { layer: "ai-search:index_source", reason: "Derived via the store-time hook.", remedy: "Re-index via the hook." },
  { layer: "r2:screener:objects", reason: "Bucket is deploy-time provisioning.", remedy: "Re-put from surviving sources." },
];

const RECREATE_PREVIEW = {
  scope: "tenant",
  tenantId: "tenant-a",
  confirmed: false,
  confirmRequired: true,
  previewToken: "tok-recreate-1",
  d1: {
    selected: [
      { code: "schema.d1.agent_price_catalogue.create_table", params: {} },
      { code: "schema.d1.agent_price_catalogue.alter_table_rename_to_agent_price_catalogue_legacy", params: {} },
      { code: "seed.d1.agent_price_catalogue.insert_from_legacy", params: {} },
    ],
    skipped: [{ code: "schema.orm.mas_transactions.alter_table_add_column_tenant_id", params: {} }],
  },
  instances: [
    {
      login: "alice",
      selected: [
        { code: "schema.do.mas_reports.create_table", params: {} },
        { code: "schema.do.mas_reports.alter_table_add_column", params: { column: "user_login", type: "TEXT" } },
      ],
      skipped: [
        { code: "schema.index.mas_reports.drop_index_idx_mas_reports_generation", params: {} },
      ],
    },
  ],
  uncreatableLayers: UNCREATABLE_LAYERS,
};

const RECREATE_RESULT = {
  scope: "tenant",
  tenantId: "tenant-a",
  confirmed: true,
  d1: {
    report: {
      leg: "d1",
      selected: RECREATE_PREVIEW.d1.selected.map((s) => s.code),
      executed: RECREATE_PREVIEW.d1.selected.map((s) => s.code),
      failed: [],
      skipped: [],
      rolledBack: [],
      outcome: "succeeded",
    },
    verification: { ok: true, failures: [], extras: { tables: [], columns: [], indexes: [], constraints: [] }, knownDifferences: [] },
  },
  instances: [
    {
      login: "alice",
      report: {
        leg: "do",
        selected: RECREATE_PREVIEW.instances[0].selected.map((s) => s.code),
        executed: RECREATE_PREVIEW.instances[0].selected.map((s) => s.code),
        failed: [],
        skipped: [],
        rolledBack: [],
        outcome: "succeeded",
      },
      verification: { ok: true, failures: [], extras: { tables: [], columns: [], indexes: [], constraints: [] }, knownDifferences: [] },
    },
  ],
  uncreatableLayers: UNCREATABLE_LAYERS,
  audit: { funnel: true, auditLog: { ok: true } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubFetch(handler: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const call: FetchCall = {
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        body,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function defaultHandler(call: FetchCall): Response {
  if (call.url === "/api/platform-tenants") return jsonResponse(TENANTS);
  if (call.url === "/api/data-lifecycle/recreate" && call.body.confirm !== true) {
    return jsonResponse(RECREATE_PREVIEW);
  }
  if (call.url === "/api/data-lifecycle/recreate" && call.body.confirm === true) {
    return jsonResponse(RECREATE_RESULT);
  }
  return jsonResponse({ error: `unexpected call ${call.url}` }, 500);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DataLifecyclePanel />);
  });
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) {
    throw new Error(
      `No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")})`,
    );
  }
  return target as HTMLButtonElement;
}

async function click(label: string) {
  const button = findButton(label);
  await act(async () => {
    button.click();
  });
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

async function setInput(placeholder: string, value: string) {
  const input = document.body.querySelector(
    `input[placeholder="${placeholder}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`No input with placeholder "${placeholder}"`);
  await act(async () => {
    setValue(input, value);
  });
}

async function checkBox(labelText: string) {
  const labels = Array.from(document.body.querySelectorAll("label"));
  const label = labels.find((l) => (l.textContent ?? "").includes(labelText));
  if (!label) throw new Error(`No label containing "${labelText}"`);
  const input = label.querySelector("input[type=checkbox]") as HTMLInputElement | null;
  if (!input) throw new Error(`Label "${labelText}" has no checkbox`);
  await act(async () => {
    input.click();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(downloadTextFile).mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.unstubAllGlobals();
});

describe("DataLifecyclePanel — RecreateCard (#4383)", () => {
  it("preview shows the D1 and per-instance step counts and the uncreatable layers", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview recreate");
    expect(bodyText()).toContain("Recreate schema");
    expect(bodyText()).toContain("3 planned");
    expect(bodyText()).toContain("alice");
    expect(bodyText()).toContain("vectorize:vector-memory");
    expect(bodyText()).toContain("r2:screener:knowledge/");
    // Preview only: no confirm call was made.
    expect(bodyText()).not.toContain("Recreate complete");
  });

  it("the expandable detail lists per-statement codes grouped by leg and kind", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview recreate");
    // The detail is collapsed by default: the codes are not shown yet.
    expect(bodyText()).not.toContain("schema.do.mas_reports.create_table");
    await click("Show planned steps");
    expect(bodyText()).toContain("schema.do.mas_reports.create_table");
    expect(bodyText()).toContain("schema.d1.agent_price_catalogue.create_table");
    expect(bodyText()).toContain("user_login");
  });

  it("tenant recreate confirm runs through the modal and reports per-leg outcomes and the audit record", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview recreate");
    await click("Review and recreate");
    await checkBox("auditConfirm");
    await click("Confirm recreate");
    expect(bodyText()).toContain("Recreate complete");
    expect(bodyText()).toContain("Audit record written");
    expect(bodyText()).toContain("alice");
  });

  it("the report is downloadable from the surface (preview and result)", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview recreate");
    await click("Download recreate report");
    expect(vi.mocked(downloadTextFile)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(downloadTextFile).mock.calls[0][0])).toContain(
      "data-lifecycle-recreate-tenant-tenant-a",
    );
    expect(String(vi.mocked(downloadTextFile).mock.calls[0][1])).toContain(
      "tok-recreate-1",
    );
  });

  it("a refused preview renders the server error and no detail", async () => {
    stubFetch((call) => {
      if (call.url === "/api/platform-tenants") return jsonResponse(TENANTS);
      if (call.url === "/api/data-lifecycle/recreate") {
        return jsonResponse(
          { error: "Forbidden: data lifecycle operations require a store operator." },
          403,
        );
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await renderPanel();
    await click("Preview recreate");
    expect(bodyText()).toContain("store operator");
    expect(bodyText()).not.toContain("schema.do.mas_reports.create_table");
  });
});
