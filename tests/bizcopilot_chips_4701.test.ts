/**
 * Issue #4701 — every BizCopilot quick chip must send a prompt its
 * parser accepts. The "Create a tenant" chip's prompt was pinned
 * null by the tenant parser test, so the turn fell through to the
 * LLM, which falsely denied the tenant capability exists. This
 * pins every biz chip prompt against parser acceptance in exactly
 * one of the three BizCopilot parsers: a chip that parses nowhere
 * falls through, and a chip that parses in two places is
 * ambiguous about which branch runs.
 */
import { describe, it, expect } from "vitest";
import { findCopilot } from "../src/client/chat/copilotRegistry";
import { parseBizCopilotAccountIntent } from "../src/services/bizCopilotAccounts";
import { parseBizCopilotChannelIntent } from "../src/services/bizCopilotChannels";
import { parseBizCopilotTenantIntent } from "../src/services/bizCopilotTenants";

describe("BizCopilot quick chips (#4701)", () => {
  it("every biz quick chip prompt parses in exactly one BizCopilot parser", () => {
    const biz = findCopilot("biz");
    expect(biz).toBeDefined();
    const chips = biz?.quickChips ?? [];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const matches = [
        parseBizCopilotTenantIntent(chip.prompt),
        parseBizCopilotAccountIntent(chip.prompt),
        parseBizCopilotChannelIntent(chip.prompt),
      ].filter((intent) => intent !== null);
      expect(matches, chip.prompt).toHaveLength(1);
    }
  });
});
