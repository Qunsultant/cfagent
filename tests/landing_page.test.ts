import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/landing";
import { renderLoginPage } from "../src/oauth";

describe("pre-login pages", () => {
  it("landing page explains capabilities and links to sign-in", () => {
    const html = renderLandingPage("Test App");
    expect(html).toContain("Quant vs LLM comparison");
    expect(html).toContain("Fast order ticket");
    expect(html).toContain("trading-platform order preview");
    expect(html).toContain("Options strategy screening");
    expect(html).toContain("Signed, audited trade drafts");
    expect(html).toContain('href="/login"');
  });

  it("login card is focused strictly on authentication without feature clutter", () => {
    const html = renderLoginPage({} as any);
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('href="/auth/login"');
    expect(html).not.toContain("trading-platform order preview");
    expect(html).not.toContain("RAG");
    expect(html).not.toContain("Payment");
  });

  it("login page shows provider icons, not bars (#3363)", () => {
    const html = renderLoginPage({} as any);
    expect(html).toContain('aria-label="Sign in with GitHub"');
    expect(html).toContain('class="btn btn-github provider-icon"');
    expect(html).not.toContain("<span>Sign in with");
    expect(html).not.toContain("btn-arrow");
  });

  it("multi-provider login shows an icon per provider, each with its accessible name (#3363)", () => {
    const html = renderLoginPage({} as any, [
      { id: "github", displayName: "GitHub" },
      { id: "google", displayName: "Google" },
    ]);
    expect(html).toContain('aria-label="Sign in with GitHub"');
    expect(html).toContain('aria-label="Sign in with Google"');
    expect(html).toContain('href="/auth/login/github"');
    expect(html).toContain('href="/auth/login/google"');
    expect(html).not.toContain("<span>Sign in with");
    expect(html).not.toContain("btn-arrow");
    // Google's mark is the single-path monochrome "G" (simple-icons).
    expect(html).toContain("M12.48 10.92v3.28h7.84");
  });
});
