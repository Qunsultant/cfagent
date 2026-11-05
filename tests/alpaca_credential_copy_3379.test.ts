/**
 * Issue #3379 — the Alpaca panel must not deny the sign-in it renders.
 *
 * The warning said "the key and secret are deployment secrets; this surface
 * never asks for them" directly above `<AlpacaSignInCard />`, which asks for
 * exactly those two values. These pins hold the copy to what the screen does:
 * both routes are named, and the false sentence cannot come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/client/AlpacaBrokerPanel.tsx", "utf8");

describe("the Alpaca panel describes both credential paths (#3379)", () => {
  it("does not deny that the surface asks for a key pair", () => {
    expect(source).not.toContain("never asks for them");
  });

  it("names the sign-in route", () => {
    expect(source).toContain("Sign in above with your own key pair");
  });

  it("still names the deployment variables for this environment", () => {
    // The deployment pair remains the fallback, and the notice still carries
    // the variable names so a deployment operator knows what to set.
    expect(source).toContain("data-broker-credential-vars");
    expect(source).toContain('guidanceEnvNames.join(", ")');
  });

  it("keeps the sign-in card mounted on the panel", () => {
    expect(source).toContain("<AlpacaSignInCard");
  });
});
