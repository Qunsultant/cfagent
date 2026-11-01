/**
 * Issue #1185 (design #1066), closed by #2681: the legacy shared
 * identity is gone, and the legacy shared ADDRESS is gone too.
 *
 * Before #2681 the literal "default_trader" survived in exactly one
 * place in src/ — the SHARED_ORCHESTRATOR_INSTANCE address in
 * src/security/serviceIdentity.ts. After #2681 the live address is
 * "shared_orchestrator" and the literal survives ONLY as the
 * LEGACY_SHARED_ORCHESTRATOR_INSTANCE constant in the same file:
 * in-flight queued messages naming the legacy address must still be
 * denied as fabricated identity, and the migration driver takes its
 * source address explicitly. It must never again appear as a live
 * address, a fallback login, a default parameter, a token key, an
 * audit identity, or a payer anywhere in src/.
 *
 * Test files are out of scope: fixtures may use the string as an
 * explicit owner login (a fixture choice, not a fallback).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "src");
const ALLOWED = join("src", "security", "serviceIdentity.ts");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

describe("issue #1185/#2681: default_trader removal pin", () => {
  it("the literal survives only as the legacy constant in serviceIdentity.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = join("src", file.slice(SRC_ROOT.length + 1));
      if (rel === ALLOWED) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("default_trader")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("serviceIdentity.ts keeps the literal only in the legacy constant, and the live address is renamed", () => {
    const text = readFileSync(join(SRC_ROOT, "security", "serviceIdentity.ts"), "utf8");
    const lines = text.split("\n").filter((l) => l.includes("default_trader"));
    // The legacy constant definition (and any comment line referencing
    // its history) — no code path may use it as a login or live address.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/LEGACY_SHARED_ORCHESTRATOR_INSTANCE|legacy/i);
    }
    expect(text).toContain('export const LEGACY_SHARED_ORCHESTRATOR_INSTANCE = "default_trader";');
    expect(text).toContain('export const SHARED_ORCHESTRATOR_INSTANCE = "shared_orchestrator";');
    // The live constant must not be the legacy address. (A plain
    // not.toContain would also match the LEGACY_ constant, whose name
    // contains the live constant's name as a substring.)
    expect(
      text.split("\n").some((l) => l.trim() === 'export const SHARED_ORCHESTRATOR_INSTANCE = "default_trader";'),
    ).toBe(false);
  });
});
