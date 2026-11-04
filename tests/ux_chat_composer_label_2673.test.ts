/**
 * Issue #2673 (slice 6) — Chat composer accessible name.
 *
 * The composer input had only a placeholder (which vanishes once the
 * user types and is not a persistent accessible name) and no label,
 * hint, error, or aria-label, so assistive tech announced an
 * unnamed text field. The fix adds an aria-label to the composer's
 * input (Fluent Input forwards aria-label to the input element),
 * with zero visual change. #3146 migrated the composer from our
 * TextInput to Fluent Input; the accessible-name guarantee is
 * unchanged, only the component name in this pin moved with it.
 *
 * Pin style is a focused source assertion: the composer is inline
 * in AgentChatTabContent, whose agent hooks (@cloudflare/ai-chat,
 * agents/react) make a jsdom render heavy and brittle for a
 * one-attribute guarantee. The assertion scopes to the
 * chat-input-bar form, whose only aria-label candidate is the
 * composer's input (the Send button has visible text).
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

describe("Chat composer accessible name (#2673 slice 6)", () => {
  it("the composer input carries an aria-label (not placeholder-only)", () => {
    const form = composerForm();
    expect(form).toContain("<Input");
    expect(form).toMatch(/aria-label="[^"]+"/);
  });
});
