/**
 * Issue #2860 (audit follow-up) — standards evidence pack.
 *
 * The audit found standards PARTIAL: no ASVS / WCAG /
 * SOC 2 / ISO claim was supported for the stock
 * programme. This pack does NOT create a new compliance
 * claim. It records, per standard, whether the repo
 * states a target or a claim, and what evidence exists
 * for stock code — so a future slice cannot cite a
 * target as a compliance claim, and cannot silently
 * reintroduce an un-evidenced claim.
 *
 * Pins:
 *  - the pack exists and carries the verdict per
 *    standard (ASVS TARGET-ONLY, WCAG TARGET-ONLY,
 *    SOC 2 NO ATTESTATION, ISO NO CLAIM, 15-factor
 *    QUALIFIED);
 *  - screener.md §9 (the pre-existing FULL COMPLIANCE
 *    table) carries a scope note: it is not evidence
 *    for new stock-programme code;
 *  - no stock source file carries a compliance-claim
 *    phrase (the one "Certified" hit in the client is
 *    a "Certified Timestamp" data label, not a claim,
 *    and matches none of these phrases).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACK = "docs/architecture/standards/stock-programme-evidence.md";

describe("standards evidence pack (#2860)", () => {
  it("the pack exists and carries one verdict per standard", () => {
    expect(existsSync(PACK)).toBe(true);
    const doc = readFileSync(PACK, "utf8");
    expect(doc).toContain("OWASP ASVS");
    expect(doc).toContain("TARGET-ONLY");
    expect(doc).toContain("WCAG 2.2 AA");
    expect(doc).toContain("SOC 2");
    expect(doc).toContain("NO ATTESTATION");
    expect(doc).toContain("ISO");
    expect(doc).toContain("NO CLAIM");
    expect(doc).toContain("15-factor");
    expect(doc).toContain("QUALIFIED");
    expect(doc).toContain("no new compliance claim");
  });

  it("screener.md §9 carries the scope note (not evidence for new stock code)", () => {
    const doc = readFileSync("docs/architecture/application/screener.md", "utf8");
    const start = doc.indexOf("## 9. Compliance with 15-Factor");
    expect(start).toBeGreaterThan(-1);
    const end = doc.indexOf("## 10.", start);
    expect(end).toBeGreaterThan(start);
    const section = doc.slice(start, end);
    expect(section).toContain("not evidence for new stock-programme code");
    expect(section).toContain("#2860");
  });

  it("no stock source file carries a compliance-claim phrase", () => {
    const phrases = [
      "FULL COMPLIANCE",
      "SOC 2 compliant",
      "WCAG compliant",
      "ASVS compliant",
      "ISO 27001 compliant",
      "fully compliant",
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const text = readFileSync(path, "utf8");
          for (const phrase of phrases) {
            if (text.includes(phrase)) offenders.push(`${path}: ${phrase}`);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
