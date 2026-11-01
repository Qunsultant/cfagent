/**
 * Issue #2223 (slice 1) — A2A foundation: A2A-owned resolution map +
 * dispatcher behavior.
 *
 * The pre-#2223 dispatcher resolved names through the planner's
 * OPERATION_CATALOG (src/orchestrate.ts): "orchestrator" had no entry
 * (404), tasks/memory/nlq pointed at bindings that do not exist
 * (500), and every name resolved to idFromName(<url-name>) — which
 * for the orchestrator fragments mas_* state across one virgin
 * instance per surface name, and for ScheduledAgent lands on a
 * virgin instance seeded with DEFAULT_SCHEDULES (SURVEY §1.4, §6.2).
 *
 * The fix pinned here: src/a2a/resolution.ts owns name → { binding,
 * instanceName? }; OPERATION_CATALOG is untouched (planner behavior
 * cannot move); the dispatcher resolves through the map; the path
 * regex accepts hyphens so a name like "report-asset" reaches
 * resolution instead of dying at the route.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  A2A_RESOLUTIONS,
  resolveA2AAgent,
  resolveA2AInstanceName,
} from "../src/a2a/resolution";
import { handleA2A } from "../src/a2a/index";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../src/security/serviceIdentity";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

const wrangler = JSON.parse(
  stripJsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")),
) as {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
};
const WRANGLER_BINDINGS = new Set(wrangler.durable_objects.bindings.map((b) => b.name));

const ORCHESTRATOR_FAMILY = ["orchestrator", "search", "tasks", "memory", "nlq"];

describe("A2A resolution map (#2223 slice 1)", () => {
  it("contains exactly the programme's final name set", () => {
    // Slice 1's set, extended by the payments/AiSearchAgent slices
    // and completed by the final slice (screener, research,
    // report-asset, browser, slack). Updated in the final slice per
    // the §7 pin rule — this is the full #2223 set. Extended once
    // since, per the same rule: sandbox (#2421, Agent Mesh S15 —
    // the #2253 recorded follow-up).
    expect(Object.keys(A2A_RESOLUTIONS).sort()).toEqual(
      ["aisearch", "browser", "memory", "nlq", "orchestrator", "payments", "report-asset", "research", "sandbox", "scheduled", "screener", "search", "slack", "tasks", "trading"].sort(),
    );
  });

  it("every entry's binding exists in wrangler.jsonc", () => {
    for (const [name, resolution] of Object.entries(A2A_RESOLUTIONS)) {
      expect(WRANGLER_BINDINGS.has(resolution.binding), `${name} → ${resolution.binding}`).toBe(true);
    }
  });

  it("orchestrator-family names all resolve to SEARCH_AGENT on the shared instance", () => {
    // SURVEY §6.4: five names on five instances would fragment
    // mas_memory / mas_transactions / mas_reports. One instance —
    // the shared orchestrator address — serves every orchestrator op.
    expect(SHARED_ORCHESTRATOR_INSTANCE).toBe("shared_orchestrator");
    for (const name of ORCHESTRATOR_FAMILY) {
      const resolution = resolveA2AAgent(name);
      expect(resolution, name).toBeDefined();
      expect(resolution!.binding).toBe("SEARCH_AGENT");
      expect(resolveA2AInstanceName(resolution!, name, {} as never)).toBe(
        SHARED_ORCHESTRATOR_INSTANCE,
      );
    }
  });

  it("scheduled resolves to SCHEDULED_AGENT on the live \"default\" instance", () => {
    // SURVEY §1.4: the bare name would seed DEFAULT_SCHEDULES in a
    // virgin instance and serve plausible-looking wrong state.
    const resolution = resolveA2AAgent("scheduled");
    expect(resolution!.binding).toBe("SCHEDULED_AGENT");
    expect(resolveA2AInstanceName(resolution!, "scheduled", {} as never)).toBe("default");
  });

  it("trading resolution is preserved verbatim (TRADING_AGENT, instance \"trading\")", () => {
    const resolution = resolveA2AAgent("trading");
    expect(resolution!.binding).toBe("TRADING_AGENT");
    expect(resolveA2AInstanceName(resolution!, "trading", {} as never)).toBe("trading");
  });

  it("payments carries no instance override — the URL name is the instance (parity)", () => {
    const resolution = resolveA2AAgent("payments");
    expect(resolution!.binding).toBe("PAYMENTS_AGENT");
    expect(resolution!.instanceName).toBeUndefined();
    expect(resolveA2AInstanceName(resolution!, "payments", {} as never)).toBe("payments");
  });

  it("unknown names do not resolve — including qa (no on-demand executor, SURVEY §6.5)", () => {
    expect(resolveA2AAgent("nope")).toBeUndefined();
    expect(resolveA2AAgent("qa")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Entrypoint behavior through the real edge dispatcher (src/a2a/index),
// with fake DO namespaces that record how they were resolved. Same
// idiom as the trading edge test in tests/trading_agent.test.ts.
// ---------------------------------------------------------------------------

function makeA2aEnv() {
  const idFromNameCalls: Array<{ binding: string; name: string }> = [];
  const stubCalls: Array<{ binding: string; body: unknown; origin: string }> = [];
  const namespace =
    (binding: string, withHandler = true) =>
    () => ({
      idFromName: (name: string) => {
        idFromNameCalls.push({ binding, name });
        return { name };
      },
      get: (_id: { name: string }) =>
        withHandler
          ? {
              handleA2A: async (body: unknown, origin: string) => {
                stubCalls.push({ binding, body, origin });
                return { text: "ok", data: { ok: true } };
              },
            }
          : {},
    });
  const ns: Record<string, () => unknown> = {
    SEARCH_AGENT: namespace("SEARCH_AGENT"),
    SCHEDULED_AGENT: namespace("SCHEDULED_AGENT"),
    TRADING_AGENT: namespace("TRADING_AGENT"),
    REPORT_ASSET_AGENT: namespace("REPORT_ASSET_AGENT"),
    // PaymentsAgent implements no handleA2A in this slice — parity
    // with production: the dispatcher's stub check must 500.
    PAYMENTS_AGENT: namespace("PAYMENTS_AGENT", false),
  };
  const env: Record<string, unknown> = { A2A_API_TOKEN: "test-token" };
  for (const [binding, make] of Object.entries(ns)) env[binding] = make();
  return { env, idFromNameCalls, stubCalls };
}

const postA2a = (path: string, token?: string) =>
  new Request(`https://agent.example${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { message: { parts: [{ kind: "data", data: { operation: "search.query", query: "x" } }] } },
    }),
  });

describe("A2A dispatcher resolves through the map (#2223 slice 1)", () => {
  it("orchestrator lands on SEARCH_AGENT's shared instance and reaches the stub", async () => {
    const { env, idFromNameCalls, stubCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/orchestrator", "test-token"), env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "SEARCH_AGENT", name: "shared_orchestrator" }]);
    expect(stubCalls).toHaveLength(1);
  });

  it("search and memory land on the SAME shared instance (no state fragmentation)", async () => {
    const { env, idFromNameCalls } = makeA2aEnv();
    expect((await handleA2A(postA2a("/a2a/search", "test-token"), env)).status).toBe(200);
    expect((await handleA2A(postA2a("/a2a/memory", "test-token"), env)).status).toBe(200);
    expect(idFromNameCalls).toEqual([
      { binding: "SEARCH_AGENT", name: "shared_orchestrator" },
      { binding: "SEARCH_AGENT", name: "shared_orchestrator" },
    ]);
  });

  it("scheduled lands on the \"default\" instance, never the seeded bare name", async () => {
    const { env, idFromNameCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/scheduled", "test-token"), env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "SCHEDULED_AGENT", name: "default" }]);
  });

  it("trading resolution is byte-identical to the pre-map behavior", async () => {
    const { env, idFromNameCalls, stubCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/trading", "test-token"), env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "TRADING_AGENT", name: "trading" }]);
    expect(stubCalls).toHaveLength(1);
  });

  it("payments reaches the stub check and 500s exactly as today (handler is a later slice)", async () => {
    const { env, idFromNameCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/payments", "test-token"), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Agent does not expose handleA2A");
    expect(idFromNameCalls).toEqual([{ binding: "PAYMENTS_AGENT", name: "payments" }]);
  });

  it("unknown name with a valid token 404s at resolution; with a wrong token it 401s first", async () => {
    const { env, stubCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/nope", "test-token"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Unknown agent: nope");
    expect((await handleA2A(postA2a("/a2a/nope", "wr0ng"), env)).status).toBe(401);
    expect(stubCalls).toHaveLength(0);
  });

  it("hyphenated names reach resolution instead of dying at the route", async () => {
    const { env, idFromNameCalls, stubCalls } = makeA2aEnv();
    const res = await handleA2A(postA2a("/a2a/report-asset", "test-token"), env);
    // Slice 1 proved the hyphenated name reaches resolution (it 404'd
    // there as an unknown agent); the final slice adds the
    // report-asset resolution, so the same request now lands on
    // REPORT_ASSET_AGENT's "default" instance and reaches the stub.
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "REPORT_ASSET_AGENT", name: "default" }]);
    expect(stubCalls).toHaveLength(1);
  });
});
