/**
 * Incident #3407 — Copilot chat no longer scrolls since the Fluent
 * migration (#3146, PR #3200).
 *
 * FluentProvider renders a plain block <div> root (its Griffel styles
 * set only color/background/typography), which broke the flex height
 * chain tab-viewport → .chat-view → .messages-stream: .chat-view's
 * flex: 1 went inert, the stream grew with content and never
 * overflowed, and the scrollIntoView effect scrolled the document
 * instead of the pane. The fix grows the Fluent root itself with
 * Griffel (same pattern as the #3230 composer fix): it takes over
 * the flex-item role .chat-view used to have.
 *
 * Pin style is a focused source assertion, same reason as #2673:
 * rendering the full chat in jsdom is heavy and brittle (agent
 * hooks), and the guarantee here is structural — which class the
 * provider root carries and what that class declares.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chatPath = join(here, "..", "src", "client", "chat", "AgentChatTabContent.tsx");

function readChat(): string {
  return readFileSync(chatPath, "utf8");
}

function providerStylesBlock(): string {
  const src = readChat();
  const start = src.indexOf("const useProviderStyles = makeStyles({");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("});", start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe("chat scroll chain survives the Fluent provider (#3407)", () => {
  it("FluentProvider root carries the flex-constraining Griffel class", () => {
    const src = readChat();
    expect(src).toContain("const providerStyles = useProviderStyles();");
    expect(src).toContain(
      '<FluentProvider theme={fluentTheme} className={providerStyles.provider}>'
    );
  });

  it("the provider styles make the root a shrinking flex column", () => {
    const block = providerStylesBlock();
    expect(block).toContain('display: "flex"');
    expect(block).toContain('flexDirection: "column"');
    expect(block).toContain("flexGrow: 1");
    expect(block).toContain("minHeight: 0");
  });

  it("the scroll effect and stream container are intact", () => {
    const src = readChat();
    expect(src).toContain("messagesEndRef.current?.scrollIntoView");
    expect(src).toContain('className="messages-stream"');
  });
});
