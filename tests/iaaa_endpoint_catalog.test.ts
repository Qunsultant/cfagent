import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_ENDPOINT_CATALOG,
  IAAA_AUDIT_EVENT_CATALOG,
  IAAA_CATALOG_GAPS,
  IAAA_CORRELATION_ROWS,
} from "../src/client/iaaaEndpointCatalog";
import {
  MCP_PROMPTS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_TOOLS_CATALOG,
} from "../src/client/mcpEndpointsData";

/**
 * #945 IAAA-UI v2 — endpoint/event explorer catalog integrity.
 *
 * The API catalog is static code knowledge derived by reading
 * src/server.ts's route table; the MCP tab reuses the existing
 * client catalogs; the IAAA tab enumerates the audit builders and
 * their live call sites. Nothing here may be invented: an unknown
 * is a gap row, and every correlation row must cite a real source.
 */

const endpointIds = new Set(API_ENDPOINT_CATALOG.map((e) => e.id));
const endpointPaths = new Set<string>();
for (const e of API_ENDPOINT_CATALOG) {
  endpointPaths.add(e.path);
  for (const a of e.aliases) endpointPaths.add(a);
}
const mcpToolNames = new Set(MCP_TOOLS_CATALOG.map((t) => t.name));
const mcpResourceUris = new Set(MCP_RESOURCES_CATALOG.map((r) => r.uri));
const mcpPromptNames = new Set(MCP_PROMPTS_CATALOG.map((p) => p.name));
const eventActions = new Set(IAAA_AUDIT_EVENT_CATALOG.map((e) => e.action));

describe("API endpoint catalog", () => {
  it("has unique ids, and no (method, path) pair is claimed twice", () => {
    expect(endpointIds.size).toBe(API_ENDPOINT_CATALOG.length);
    expect(API_ENDPOINT_CATALOG.length).toBeGreaterThan(0);
    const seen = new Map<string, string>();
    for (const e of API_ENDPOINT_CATALOG) {
      expect(e.method).toBeTruthy();
      expect(e.path).toBeTruthy();
      expect(e.auth).toBeTruthy();
      expect(e.source).toBeTruthy();
      for (const p of [e.path, ...e.aliases]) {
        const key = `${e.method} ${p}`;
        const prev = seen.get(key);
        expect(prev, `${key} claimed by both ${prev} and ${e.id}`).toBeUndefined();
        seen.set(key, e.id);
      }
    }
  });

  it("covers every route-branch path literal in src/server.ts (source pin)", () => {
    // A new route branch that adds a path literal without a catalog
    // entry must fail here. Extraction is deliberately narrow: only
    // literals in `path ===`, `path.startsWith`, and `path.match`
    // conditions count as route branches. Internal forward URLs
    // (new URL("/mcp" ...), "/api/jobs/..." inside DO code) are not
    // route branches and are excluded by construction.
    // Residual gap (documented): the pin covers path literals, not
    // method/auth changes to an existing branch — those are reviewed
    // against the catalog by hand when server.ts changes.
    const server = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8");
    const exact = new Set<string>();
    for (const m of server.matchAll(/path\s*===\s*"([^"]+)"/g)) exact.add(m[1]);
    const prefixes = new Set<string>();
    for (const m of server.matchAll(/path\.startsWith\("([^"]+)"\)/g)) prefixes.add(m[1]);
    const patterns = new Set<string>();
    for (const m of server.matchAll(/path\.match\((\/.*?\/)\)/g)) patterns.add(m[1]);

    const missing: string[] = [];
    for (const lit of exact) {
      if (!endpointPaths.has(lit)) missing.push(`exact ${lit}`);
    }
    for (const lit of prefixes) {
      const covered = API_ENDPOINT_CATALOG.some(
        (e) => e.prefixes?.includes(lit) || e.path === lit || e.aliases.includes(lit),
      );
      if (!covered) missing.push(`prefix ${lit}`);
    }
    for (const lit of patterns) {
      const covered = API_ENDPOINT_CATALOG.some((e) => e.pattern === lit);
      if (!covered) missing.push(`pattern ${lit}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("MCP catalog reuse", () => {
  it("pins the reused catalog sizes so drift forces a review", () => {
    // Counts verified against src/client/mcpEndpointsData.ts at v2
    // authoring time. If the catalog grows, update this pin AND the
    // MCP tab copy — do not silently let the tab go stale.
    // 36 since #3782 (+2 Alpaca quote/preview tools); the MCP tab
    // reads MCP_TOOLS_CATALOG directly, so no separate copy to update.
    expect(MCP_TOOLS_CATALOG.length).toBe(37);
    expect(MCP_RESOURCES_CATALOG.length).toBe(8);
    expect(MCP_PROMPTS_CATALOG.length).toBe(4);
  });

  it("every endpoint-mcp row references a real endpoint and a real catalog entry", () => {
    for (const row of IAAA_CORRELATION_ROWS.filter((r) => r.kind === "endpoint-mcp")) {
      expect(endpointIds.has(row.left), `unknown endpoint ${row.left}`).toBe(true);
      expect(row.source).toBeTruthy();
      if (row.right !== null) {
        const known =
          mcpToolNames.has(row.right) ||
          mcpResourceUris.has(row.right) ||
          mcpPromptNames.has(row.right);
        expect(known, `unknown MCP entry ${row.right}`).toBe(true);
      } else {
        expect(row.relation).toBe("unmapped");
      }
    }
  });
});

describe("IAAA event taxonomy and correlations", () => {
  it("every event action appears in a mapping row or in the gaps list", () => {
    const mapped = new Set(
      IAAA_CORRELATION_ROWS.filter((r) => r.kind === "event-endpoint").map((r) => r.left),
    );
    const gapItems = new Set(IAAA_CATALOG_GAPS.map((g) => g.item));
    for (const action of eventActions) {
      expect(
        mapped.has(action) || gapItems.has(action),
        `${action} is neither mapped nor listed as a gap`,
      ).toBe(true);
    }
  });

  it("every event-endpoint row references a real event or gap item, and a real endpoint (or UNMAPPED)", () => {
    const gapItems = new Set(IAAA_CATALOG_GAPS.map((g) => g.item));
    for (const row of IAAA_CORRELATION_ROWS.filter((r) => r.kind === "event-endpoint")) {
      const knownLeft = eventActions.has(row.left) || gapItems.has(row.left);
      expect(knownLeft, `unknown event or gap ${row.left}`).toBe(true);
      expect(row.source).toBeTruthy();
      if (eventActions.has(row.left) && row.right !== null) {
        expect(endpointIds.has(row.right), `unknown endpoint ${row.right}`).toBe(true);
        expect(row.relation).toBe("emits");
      }
      if (gapItems.has(row.left)) {
        expect(row.relation).toBe("unmapped");
        if (row.right !== null) {
          expect(endpointIds.has(row.right), `unknown endpoint ${row.right}`).toBe(true);
        }
      }
      if (row.right === null) {
        expect(row.relation).toBe("unmapped");
      }
    }
  });

  it("emitted events carry an emitter and endpoints; unemitted events are flagged", () => {
    for (const e of IAAA_AUDIT_EVENT_CATALOG) {
      expect(e.builder).toBeTruthy();
      expect(e.fields.length).toBeGreaterThan(0);
      if (e.emitted) {
        expect(e.emitter).toBeTruthy();
        expect(e.endpoints.length).toBeGreaterThan(0);
      } else {
        expect(e.endpoints).toEqual([]);
      }
    }
  });
});
