// @vitest-environment node
/**
 * #6151 S1 — the client-side context census pin (the "resolved once,
 * used throughout" assurance for the CLIENT, enforced by CI).
 *
 * The one shared client resolution is the platform-context store
 * (src/client/platformContextStore.ts): it fetches GET
 * /api/platform/nav-availability once per bootstrap and every surface
 * reads tier/subscriptions/roles through it. No other client file may
 * fetch those facts directly — a surface that needs them consumes the
 * store, never re-derives its own slice.
 *
 * This pin re-runs that measurement over src/client/ and holds the
 * result SHRINK-ONLY against the baseline recorded below, seeded from
 * main at aed2c9f (2026-11-23, S1):
 *
 *  - a file x reader row that is NOT in the baseline fails;
 *  - a row whose matching-call count EXCEEDS its baseline count fails;
 *  - decreases and vanished rows pass — that is the shrink the
 *    programme wants, and retiring a direct call means lowering or
 *    removing its baseline entry in the same PR.
 *
 * Adding or raising a baseline entry is a deliberate, reviewed act:
 * it requires the new row's census disposition and reason, stated
 * in the PR that does it.
 *
 * Dispositions:
 * - INTEGRATION — an existing direct reader, the migration backlog:
 *   slices S2–S4 wire these surfaces to consume the context store,
 *   and each migration lowers its baseline entry in the same PR.
 * - ADMIN — grant administration, not nav consumption: the role-grant
 *   panels list grants to manage them; they never derive visibility
 *   from the list. The row documents the use so a NEW role-fetching
 *   site is still reviewed, but the store will never carry grant
 *   lists — these rows are not a migration backlog.
 *
 * Counting rules (the same durable lessons as the server census):
 * - // line comments and block comments are stripped before
 *   counting — a counted literal inside a comment is not a call.
 * - `export [async] function <name>(` and `export const <name> = (`
 *   definition lines are excluded — defining a reader is not calling it.
 * - The pin reads FILES only — never env, never the network, never
 *   git. Scope is src/client/ (.ts/.tsx); tests/ is out of scope.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PATTERNS = [
  "fetchPlatformIdentity",
  "getIdentity",
  "fetchAccountSelf",
  "getAccount",
  "fetchRoleGrants",
] as const;

type Disposition = "INTEGRATION" | "ADMIN";

/** [file, reader, count, disposition] — shrink-only baseline. */
const BASELINE: Array<[string, string, number, Disposition]> = [
  ["src/client/BillingServicingPanel.tsx", "fetchPlatformIdentity", 1, "INTEGRATION"],
  ["src/client/CheckoutPanel.tsx", "getIdentity", 3, "INTEGRATION"],
  ["src/client/FirstRunScreen.tsx", "fetchAccountSelf", 1, "INTEGRATION"],
  ["src/client/FirstRunScreen.tsx", "fetchPlatformIdentity", 3, "INTEGRATION"],
  ["src/client/IaaaAdminPanel.tsx", "fetchRoleGrants", 1, "ADMIN"],
  ["src/client/ProductCatalogPanel.tsx", "fetchPlatformIdentity", 5, "INTEGRATION"],
  ["src/client/ReferralCodesSection.tsx", "fetchPlatformIdentity", 1, "INTEGRATION"],
  ["src/client/RoleGrantsPanel.tsx", "fetchRoleGrants", 1, "ADMIN"],
];

function stripComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*.*?\*\//gs, "");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      if (/https?:\/\//.test(line.slice(0, idx + 1))) return line;
      return line.slice(0, idx);
    })
    .join("\n");
}

function isDefinition(line: string, name: string): boolean {
  return (
    new RegExp(`^\\s*export\\s+(async\\s+)?function\\s+${name}\\s*\\(`).test(line) ||
    new RegExp(`^\\s*export\\s+const\\s+${name}\\s*=\\s*\\(`).test(line)
  );
}

function countCalls(text: string, name: string): number {
  let count = 0;
  for (const line of stripComments(text).split("\n")) {
    if (isDefinition(line, name)) continue;
    const matches = line.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
    count += matches === null ? 0 : matches.length;
  }
  return count;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
}

describe("client context census (#6151 S1)", () => {
  it("holds direct tier/subscription/role reads shrink-only", () => {
    const files: string[] = [];
    walk("src/client", files);
    const baseline = new Map(
      BASELINE.map(([file, name, count]) => [`${file}\0${name}`, count]),
    );
    const violations: string[] = [];
    for (const file of files.sort()) {
      const text = readFileSync(file, "utf-8");
      for (const name of PATTERNS) {
        const count = countCalls(text, name);
        if (count === 0) continue;
        const key = `${file}\0${name}`;
        const allowed = baseline.get(key);
        if (allowed === undefined) {
          violations.push(
            `${file} calls ${name} ${count} time(s) but has no baseline row — ` +
              `consume the platform-context store instead, or add a reviewed baseline entry`,
          );
        } else if (count > allowed) {
          violations.push(
            `${file} calls ${name} ${count} time(s), above its baseline of ${allowed} — ` +
              `consume the platform-context store instead, or raise the baseline in a reviewed PR`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
