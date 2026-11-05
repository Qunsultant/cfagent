/**
 * Issue #3230 — Chat composer full length after the Fluent migration.
 *
 * Regression from #3146: Fluent v9's <Input> renders a wrapper root
 * around the inner <input>, so the old `.chat-input-bar input
 * { flex: 1 }` rule stopped stretching the composer — the rule lands
 * on the inner input, which is not a flex item of the form, while the
 * Fluent root has no flex growth and collapses to intrinsic width.
 * The fix grows the Fluent root itself with Griffel makeStyles
 * (flexGrow: 1, minWidth: 0), applied as className on the composer
 * <Input>: no .css change, no inline style, size only.
 *
 * Pin style follows tests/ux_chat_composer_label_2673.test.ts: a
 * focused source assertion, because the composer is inline in
 * AgentChatTabContent, whose agent hooks (@cloudflare/ai-chat,
 * agents/react) make a jsdom render heavy and brittle for a width
 * guarantee.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const composerPath = join(here, "..", "src", "client", "chat", "AgentChatTabContent.tsx");

function composerForm(): string {
  const src = readFileSync(composerPath, "utf8");
  const start = src.indexOf('<form className="chat-input-bar"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("</form>", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Chat composer full width (#3230)", () => {
  it("the composer Input carries a flex-growing class on its Fluent root", () => {
    const src = readFileSync(composerPath, "utf8");
    expect(src).toContain("makeStyles");
    expect(src).toMatch(/composerInput:\s*\{\s*flexGrow:\s*1,\s*minWidth:\s*0,/);
    const form = composerForm();
    expect(form).toContain("<Input");
    expect(form).toMatch(/className=\{[^}]*composerInput[^}]*\}/);
  });
});
