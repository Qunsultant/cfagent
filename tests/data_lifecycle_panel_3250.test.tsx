/** @vitest-environment jsdom */
/**
 * DataLifecyclePanel (#3250): the Platform Admin section for
 * clean state, platform bootstrap, and tenant bootstrap.
 *
 * Fetch is stubbed at the global boundary and routed by URL, in
 * the admin_queue_wipe_panel_2173 idiom; the canned responses
 * mirror the real route shapes in
 * tests/data_lifecycle_3250.test.ts. downloadTextFile is mocked
 * so the export gate can be asserted without a real download.
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
      memberCount: 2,
    },
    {
      tenantId: "tenant-b",
      adsEnabled: true,
      autoRefreshEnabled: false,
      autoRefreshIntervalS: 15,
      dataProviderId: "etrade",
      brokerId: "etrade",
      memberCount: 1,
    },
  ],
};

const TENANT_PREVIEW = {
  scope: "tenant",
  tenantId: "tenant-a",
  confirmed: false,
  confirmRequired: true,
  previewToken: "tok-tenant-1",
  targets: [
    { id: "instance-queues", label: "Queues", kind: "instance", count: 4 },
    { id: "instance-tables", label: "Tables", kind: "instance", count: 10 },
    { id: "tenant-memberships", label: "Memberships", kind: "kv", count: 2 },
    { id: "tenant-genesis-marker", label: "Genesis marker", kind: "kv", count: 1 },
    { id: "tenant-sessions", label: "Sessions", kind: "kv", count: 1 },
  ],
};

const TENANT_RESULT = {
  scope: "tenant",
  tenantId: "tenant-a",
  confirmed: true,
  targets: TENANT_PREVIEW.targets.map((t) => ({
    id: t.id,
    label: t.label,
    kind: t.kind,
    deleted: t.count,
    verified: true,
  })),
  audit: { funnel: true, auditLog: { ok: true } },
};

const PLATFORM_PREVIEW = {
  scope: "platform",
  confirmed: false,
  confirmRequired: true,
  previewToken: "tok-platform-1",
  targets: [
    { id: "platform-memberships", label: "Memberships", kind: "kv", count: 4 },
    { id: "platform-sessions", label: "Sessions", kind: "kv", count: 3 },
  ],
};

const PLATFORM_RESULT = {
  scope: "platform",
  confirmed: true,
  targets: PLATFORM_PREVIEW.targets.map((t) => ({
    id: t.id,
    label: t.label,
    kind: t.kind,
    deleted: t.count,
    verified: true,
  })),
  audit: { funnel: true, auditLog: { ok: true } },
};

const PLATFORM_EXPORT = {
  scope: "platform",
  exportedAtMs: 1700000000000,
  targets: PLATFORM_PREVIEW.targets,
  auditLog: {
    count: 1,
    truncated: false,
    corruptSegments: 0,
    events: [{ id: "old-event" }],
  },
};

const BOOTSTRAP_CHECK = {
  tenantId: "primary",
  allPresent: false,
  elements: [
    { id: "session-store-schema", state: "present", detail: "Schema generation 1 ensured.", source: "sessionStore" },
    { id: "platform-genesis", state: "missing", detail: "No genesis marker; the window is open.", source: "iaaaGithubEndToEnd" },
    { id: "bootstrap-admins", state: "present", detail: "1 bootstrap admin entry configured.", source: "iaaaBootstrap" },
  ],
};

const BOOTSTRAP_INIT = {
  tenantId: "primary",
  confirmed: true,
  elements: BOOTSTRAP_CHECK.elements.map((e) =>
    e.id === "platform-genesis"
      ? { ...e, state: "initialized", detail: "Genesis claimed for the caller." }
      : e,
  ),
  audit: { funnel: true, auditLog: { ok: true } },
};

const TENANT_BOOT_PREVIEW = {
  tenantId: "tenant-c",
  confirmed: false,
  steps: [
    { id: "directory", status: "would-initialize", detail: "No directory record." },
    { id: "settings", status: "would-initialize", detail: "Defaults will apply." },
    { id: "founding-admin", status: "would-initialize", detail: "Resolves to a wired identity." },
    { id: "genesis", status: "not-requested", detail: "Claim not requested." },
    { id: "channels", status: "present", detail: "Defaults in effect." },
    { id: "queue-provisioning", status: "present", detail: "Lazy." },
  ],
};

const TENANT_BOOT_RESULT = {
  tenantId: "tenant-c",
  confirmed: true,
  outcome: "complete",
  steps: TENANT_BOOT_PREVIEW.steps.map((s) =>
    s.status === "would-initialize" ? { ...s, status: "initialized" } : s,
  ),
  settings: {
    adsEnabled: true,
    autoRefreshEnabled: false,
    dataProviderId: "etrade",
    brokerId: "etrade",
  },
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
  if (call.url === "/api/data-lifecycle/clean-state" && call.body.confirm !== true) {
    return jsonResponse(call.body.scope === "platform" ? PLATFORM_PREVIEW : TENANT_PREVIEW);
  }
  if (call.url === "/api/data-lifecycle/clean-state" && call.body.confirm === true) {
    return jsonResponse(call.body.scope === "platform" ? PLATFORM_RESULT : TENANT_RESULT);
  }
  if (call.url.startsWith("/api/data-lifecycle/export")) {
    return jsonResponse(PLATFORM_EXPORT);
  }
  if (call.url === "/api/data-lifecycle/bootstrap" && call.method === "GET") {
    return jsonResponse(BOOTSTRAP_CHECK);
  }
  if (call.url === "/api/data-lifecycle/bootstrap" && call.method === "POST") {
    return jsonResponse(BOOTSTRAP_INIT);
  }
  if (call.url === "/api/data-lifecycle/tenant-bootstrap") {
    return jsonResponse(call.body.confirm === true ? TENANT_BOOT_RESULT : TENANT_BOOT_PREVIEW);
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

describe("DataLifecyclePanel (#3250)", () => {
  it("clean state preview enumerates the tenant targets and confirms nothing yet", async () => {
    const calls = stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview clean state");
    expect(bodyText()).toContain("tenant-memberships");
    expect(bodyText()).toContain("tenant-genesis-marker");
    // Preview only: no confirm call was made.
    const confirms = calls.filter(
      (c) => c.url === "/api/data-lifecycle/clean-state" && c.body.confirm === true,
    );
    expect(confirms).toHaveLength(0);
  });

  it("tenant clean confirm runs through the modal and reports deleted counts and the audit record", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Preview clean state");
    await click("Review and clean");
    await checkBox("auditConfirm");
    await click("Confirm clean state");
    expect(bodyText()).toContain("Tenant clean state complete");
    expect(bodyText()).toContain("Audit record written");
  });

  it("platform clean stays disabled until the export is downloaded and the scope phrase is typed", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Platform");
    await click("Preview clean state");
    await click("Review and clean");
    expect(findButton("Confirm clean state").disabled).toBe(true);
    await click("Download pre-wipe export");
    expect(vi.mocked(downloadTextFile)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(downloadTextFile).mock.calls[0][0])).toContain(
      "data-lifecycle-export-platform",
    );
    // Export alone is not enough: the typed phrase and the
    // audit confirmation are still outstanding.
    expect(findButton("Confirm clean state").disabled).toBe(true);
    await setInput("CLEAN PLATFORM", "CLEAN PLATFORM");
    await checkBox("auditConfirm");
    expect(findButton("Confirm clean state").disabled).toBe(false);
    await click("Confirm clean state");
    expect(bodyText()).toContain("Platform clean state complete");
  });

  it("platform bootstrap check reports element states and initialize performs the missing steps", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await click("Check platform bootstrap");
    expect(bodyText()).toContain("platform-genesis");
    expect(bodyText()).toContain("missing");
    await click("Initialize platform");
    await click("Confirm initialize");
    expect(bodyText()).toContain("initialized");
  });

  it("tenant bootstrap previews per-step state, then runs and reports the outcome", async () => {
    stubFetch(defaultHandler);
    await renderPanel();
    await setInput("e.g. tenant-c", "tenant-c");
    await setInput("e.g. founder-login", "founder");
    await click("Preview tenant bootstrap");
    expect(bodyText()).toContain("would-initialize");
    await click("Run tenant bootstrap");
    await click("Confirm tenant bootstrap");
    expect(bodyText()).toContain("Tenant bootstrap complete");
    expect(bodyText()).toContain("initialized");
  });

  it("a refused preview renders the server error and no target table", async () => {
    stubFetch((call) => {
      if (call.url === "/api/platform-tenants") return jsonResponse(TENANTS);
      if (call.url === "/api/data-lifecycle/clean-state") {
        return jsonResponse(
          { error: "Forbidden: data lifecycle operations require a store operator." },
          403,
        );
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    await renderPanel();
    await click("Preview clean state");
    expect(bodyText()).toContain("store operator");
    expect(bodyText()).not.toContain("tenant-genesis-marker");
  });
});
