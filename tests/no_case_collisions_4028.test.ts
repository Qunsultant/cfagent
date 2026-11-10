/**
 * Issue #4028 — no two tracked paths under src/ may differ only by case.
 *
 * `src/client/SchedulesHome.tsx` + `schedulesHome.ts` and
 * `TradeExecutionPreview.tsx` + `tradeExecutionPreview.ts` were such a pair:
 * Linux CI resolved them exactly, while `tsc` on a case-insensitive filesystem
 * reported TS1149/TS2724 and every Windows typecheck had to be filtered by
 * hand. The module halves are now `schedulesHomeView.ts` and
 * `tradeExecutionPreviewModel.ts`; this pin keeps a new pair from landing.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "..", "src");

function dirs(dir: string): string[] {
  const out = [dir];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...dirs(full));
  }
  return out;
}

describe("Issue #4028 — no case-only path collisions", () => {
  it("keeps every directory free of names that differ only by case", () => {
    const collisions: string[] = [];
    for (const dir of dirs(SRC)) {
      const byLower = new Map<string, string[]>();
      for (const entry of readdirSync(dir)) {
        const key = entry.toLowerCase();
        byLower.set(key, [...(byLower.get(key) ?? []), entry]);
      }
      for (const [, names] of byLower) {
        if (names.length > 1) {
          collisions.push(`${relative(resolve(SRC, ".."), dir)}: ${names.join(" / ")}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
