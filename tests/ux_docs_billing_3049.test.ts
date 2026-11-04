/**
 * UX uniformity, epic #3046 slice #3049 — Docs + Billing shell migration.
 *
 * Pins the chrome mapping (not just PageShell presence, which the #3047
 * gate already asserts): the panels' old headings become the shell
 * title, their scope/description text survives verbatim, and the Docs
 * page keeps its scroll-owning outer div — .docs-report-page must stay
 * the panel root because it is the flex item of .tab-viewport (see the
 * contract comment in docsAndReports.css); a shell-outer wrap would
 * size to content and let .tab-viewport clip the tail with no
 * scrollbar. Source-scan pin, same scanner discipline as #3047.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = join(__dirname, "..");
const DOCS = readFileSync(join(HERE, "src/client/DocsAndReportsPanel.tsx"), "utf8");
const BILLING = readFileSync(join(HERE, "src/client/BillingServicingPanel.tsx"), "utf8");
const REGISTER = JSON.parse(
  readFileSync(join(HERE, "tests/ux_shell_exceptions_3047.json"), "utf8"),
) as { routes: Record<string, unknown> };

describe("Docs + Billing shell migration (#3049)", () => {
  it("Docs renders inside a PageShell titled Docs & Reports", () => {
    expect(DOCS).toContain("<PageShell");
    expect(DOCS).toContain('title="Docs & Reports"');
    expect(DOCS).toContain("Every document set produced by a screener-workflow run");
  });

  it("Docs keeps its scroll-owning outer div and its toolbar, drops its own header", () => {
    expect(DOCS).toContain('<div className="docs-report-page">');
    expect(DOCS).toContain("docs-toolbar");
    expect(DOCS).toContain("Refresh");
    expect(DOCS).not.toContain("docs-header");
    expect(DOCS).not.toContain('<h2 className="docs-title">');
  });

  it("Billing renders inside a PageShell with its servicing description intact", () => {
    expect(BILLING).toContain("<PageShell");
    expect(BILLING).toContain('title="Billing"');
    expect(BILLING).toContain("Your subscription, receipts, plans, and referral-credit balance");
  });

  it("docs and billing are no longer migration entries in the exceptions register", () => {
    expect(REGISTER.routes["docs"]).toBeUndefined();
    expect(REGISTER.routes["billing"]).toBeUndefined();
  });
});
