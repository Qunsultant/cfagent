/**
 * Issue #3420 (epic #3416) — the last places the hub printed a broker's name.
 *
 * The audit rule this file makes mechanical: a surface that a tenant of ANY
 * broker can reach must name the SELECTED broker; copy that describes a flow
 * only one broker has (E*TRADE's OAuth redirect, PIN, diagnostics) keeps that
 * broker's name, because neutralising it would describe a flow that does not
 * exist for anyone else.
 *
 * The strings below are the ones the audit found on broker-neutral surfaces:
 *   - the OAuth/error banner title, which also carries a broker READ failure
 *     (an Alpaca positions error used to appear under "E*TRADE connection"),
 *   - the screen-error sentence,
 *   - the order preview modal (legs, upstream session, commission, approve CTA),
 *   - the fresh-preview error path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HUB = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");

/** Copy a tenant of any broker can reach — must follow the selection. */
const BROKER_NEUTRAL_COPY = [
  "Legs sent to {presentation.label}",
  "{presentation.label} Upstream Session:",
  "See ${presentation.label} account disclosure",
  "$0.00 (${presentation.label} online)",
  "Approve & Submit Trade to ${presentation.label}",
  "Unable to reach the ${presentation.label} screening API.",
  "title={`${presentation.label} connection`}",
] as const;

/** The pre-#3420 spellings. Any reappearance is a regression. */
const REMOVED_COPY = [
  "Legs sent to E*TRADE",
  "E*TRADE Upstream Session",
  "See E*TRADE account disclosure",
  "$0.00 (E*TRADE Online)",
  "Approve & Submit Trade to E*TRADE",
  "Unable to reach the E*TRADE screening API",
] as const;

describe("residual broker hardcoding on neutral surfaces (#3420)", () => {
  it("names the selected broker in every broker-neutral sentence", () => {
    for (const copy of BROKER_NEUTRAL_COPY) {
      expect(HUB, copy).toContain(copy);
    }
  });

  it("no longer prints E*TRADE's name where any broker can land", () => {
    for (const copy of REMOVED_COPY) {
      expect(HUB, copy).not.toContain(copy);
    }
  });

  it("keeps E*TRADE's name on the flows only E*TRADE has", () => {
    // Neutralising these would tell an Alpaca tenant to enter an E*TRADE PIN
    // that does not exist, or to run diagnostics against a session they do not
    // have. The honest copy for another broker is a stated refusal, which the
    // hub already renders through `diagnosticsEndpoint()` returning null.
    expect(HUB).toContain("Authorize E*TRADE Application");
    expect(HUB).toContain("E*TRADE Live REST Diagnostics");
    // The blocked-authorization-tab notice belongs to E*TRADE's OAuth redirect
    // only; `blockedAuthUrl` is set by `handleStartOAuth`.
    expect(HUB).toContain('title="E*TRADE connection"');
  });

  it("derives the neutral copy from the one presentation module", () => {
    // A surface that composes its own label ("Alpaca" / "E*TRADE" ternaries)
    // re-creates the defect one broker later.
    expect(HUB).toContain("brokerPresentation(selectedBroker)");
    expect(HUB).not.toMatch(/presentation\.label\s*===\s*["']/);
  });
});
