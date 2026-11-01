/**
 * #1765 (parent #1717, F-41 / PRV-001–PRV-004 / PRV-006): Privacy/DSAR.
 *
 * TDD Red pins, written before the implementation. The slice covers:
 *  (1) automated erasure cascade, (2) user-facing data-export endpoint,
 *  (3) ADMT pre-use notice/opt-out, (4) Sec-GPC parse + enforce,
 *  (5) universal retention via the SHARED retention registry (the
 *  #1766 slice extends the same registry — never a second mechanism).
 *
 * The cascade is port-first: legs are registered adapters, and the
 * report names every leg's outcome, so "zero residuals" is a claim
 * about the covered legs only. A leg whose store cannot be keyed
 * by subject in this slice is registered as `deferred`, never
 * silently omitted, and its absence is a named follow-up — not a
 * pass. Vectorize is deferred for exactly that reason: no
 * per-subject vector key exists on current main.
 */
import { describe, expect, it } from "vitest";
import {
  ADMT_NOTICE_VERSION,
  admtNotice,
  applyGpcToPreferences,
  buildErasureReport,
  buildExportPayload,
  eraseSubject,
  parseSecGpc,
  PRIVACY_RETENTION_TABLES,
  resolvePrivacyDsarMode,
  retentionRuleFor,
  type ErasureLeg,
  type PrivacyPreferences,
} from "../src/privacy/privacyDsar";
import { resolvePrivacyModeScoped } from "../src/config/privacyModes";
import {
  handlePrivacyErasureRoute,
  handlePrivacyExportRoute,
  handlePrivacyPreferencesRoute,
  handlePrivacyStatusRoute,
} from "../src/privacy/privacyRoutes";

const SUBJECT = "subject-1765";
const OTHER = "other-subject";

function memoryLeg(name: string, rows: string[]): ErasureLeg & { rows: string[] } {
  const leg: ErasureLeg & { rows: string[] } = {
    name,
    rows,
    async erase(subject: string) {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r !== subject);
      return { deleted: before - this.rows.length, residual: this.rows.includes(subject) ? 1 : 0 };
    },
    async count(subject: string) {
      return this.rows.filter((r) => r === subject).length;
    },
  };
  return leg;
}

describe("Sec-GPC parsing (PRV-004)", () => {
  it("parses Sec-GPC: 1 as opt-out, case-insensitively, ignoring surrounding space", () => {
    expect(parseSecGpc("1")).toBe(true);
    expect(parseSecGpc(" 1 ")).toBe(true);
    expect(parseSecGpc("0")).toBe(false);
    expect(parseSecGpc(null)).toBe(false);
    expect(parseSecGpc(undefined)).toBe(false);
    expect(parseSecGpc("")).toBe(false);
    expect(parseSecGpc("yes")).toBe(false);
  });

  it("GPC opt-out forces sale/sharing + ADMT opt-outs on, never off", () => {
    const prefs: PrivacyPreferences = { saleSharingOptOut: false, admtOptOut: false };
    expect(applyGpcToPreferences(prefs, true)).toEqual({ saleSharingOptOut: true, admtOptOut: true });
    // GPC absent never clears an existing opt-out.
    expect(applyGpcToPreferences({ saleSharingOptOut: true, admtOptOut: true }, false)).toEqual({
      saleSharingOptOut: true,
      admtOptOut: true,
    });
    expect(applyGpcToPreferences(prefs, false)).toEqual(prefs);
  });
});

describe("privacy mode switch (NEVER-EITHER/OR, scoped, fail-closed)", () => {
  it("resolves run > session > user > env > builtin (standard), invalid fails closed to standard", () => {
    expect(resolvePrivacyModeScoped({}).mode).toBe("standard");
    expect(resolvePrivacyModeScoped({ env: "strict" }).mode).toBe("strict");
    expect(resolvePrivacyModeScoped({ env: "strict", user: "standard" }).mode).toBe("standard");
    expect(resolvePrivacyModeScoped({ env: "strict", session: "standard" }).mode).toBe("standard");
    expect(resolvePrivacyModeScoped({ env: "strict", run: "standard" }).mode).toBe("standard");
    const bad = resolvePrivacyModeScoped({ env: "bogus" });
    expect(bad.mode).toBe("standard");
    expect(bad.invalid).toBe(true);
    expect(bad.level).toBe("env");
  });

  it("legacy env-only resolver agrees with the scoped resolver at the env level", () => {
    expect(resolvePrivacyDsarMode("STRICT").mode).toBe("strict");
    expect(resolvePrivacyDsarMode("bogus").mode).toBe("standard");
    expect(resolvePrivacyDsarMode(undefined).mode).toBe("standard");
  });
});

describe("erasure cascade (PRV-001)", () => {
  it("deletes the subject from every covered leg and proves zero residuals", async () => {
    const legs = [
      memoryLeg("session", [SUBJECT, OTHER]),
      memoryLeg("orchestrator", [SUBJECT]),
      memoryLeg("research", [SUBJECT, SUBJECT]),
      memoryLeg("screener", [OTHER]),
    ];
    const report = await eraseSubject(SUBJECT, legs);
    expect(report.subject).toBe(SUBJECT);
    expect(report.residualTotal).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.legs.find((l) => l.name === "session")?.deleted).toBe(1);
    expect(report.legs.find((l) => l.name === "research")?.deleted).toBe(2);
    expect(report.legs.find((l) => l.name === "screener")?.deleted).toBe(0);
    // The other subject is untouched.
    expect(legs[0].rows).toEqual([OTHER]);
    expect(legs[3].rows).toEqual([OTHER]);
  });

  it("a leg failure is reported per-leg and fails the cascade closed, never silently dropped", async () => {
    const failing: ErasureLeg = {
      name: "research",
      async erase() {
        throw new Error("store unavailable");
      },
      async count() {
        return 1;
      },
    };
    const report = await eraseSubject(SUBJECT, [memoryLeg("session", [SUBJECT]), failing]);
    expect(report.complete).toBe(false);
    expect(report.legs.find((l) => l.name === "research")?.status).toBe("failed");
    expect(report.residualTotal).toBeGreaterThan(0);
  });

  it("a deferred leg is reported as deferred, never counted as erased", async () => {
    const report = await eraseSubject(SUBJECT, [
      memoryLeg("session", [SUBJECT]),
      { name: "vectorize", deferred: "no per-subject vector key on current main" } as ErasureLeg,
    ]);
    const leg = report.legs.find((l) => l.name === "vectorize");
    expect(leg?.status).toBe("deferred");
    expect(report.complete).toBe(false);
    expect(report.deferred).toContain("vectorize");
  });

  it("the report builder refuses to claim completeness with residuals", () => {
    const report = buildErasureReport(SUBJECT, [
      { name: "session", status: "erased", deleted: 1, residual: 0 },
      { name: "research", status: "erased", deleted: 0, residual: 2 },
    ]);
    expect(report.complete).toBe(false);
    expect(report.residualTotal).toBe(2);
  });
});

describe("data export (PRV-002)", () => {
  it("assembles a consolidated, subject-scoped JSON payload", () => {
    const payload = buildExportPayload({
      subject: SUBJECT,
      session: { login: "octo", createdAt: 1000 },
      messages: [{ id: "m1", body: "hello" }],
      researchRuns: [{ id: "r1" }],
      screenerRuns: [],
      preferences: { saleSharingOptOut: true, admtOptOut: false },
      generatedAt: 2000,
    });
    expect(payload.subject).toBe(SUBJECT);
    expect(payload.generatedAt).toBe(2000);
    expect(payload.messages).toHaveLength(1);
    expect(payload.researchRuns).toHaveLength(1);
    expect(payload.preferences.saleSharingOptOut).toBe(true);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe("ADMT notice + opt-out (PRV-003)", () => {
  it("the notice names the logic, the consequential use, and the opt-out right", () => {
    const notice = admtNotice();
    expect(notice.version).toBe(ADMT_NOTICE_VERSION);
    expect(notice.logic).toMatch(/research|screener/i);
    expect(notice.optOutRoute).toBe("/api/privacy/preferences");
    expect(notice.consequentialUses.length).toBeGreaterThan(0);
  });

  it("an opted-out subject routes to the static path; an opted-in subject routes to ADMT", () => {
    expect(admtNotice({ admtOptOut: true }).effectiveRoute).toBe("static");
    expect(admtNotice({ admtOptOut: false }).effectiveRoute).toBe("admt");
    expect(admtNotice().effectiveRoute).toBe("admt");
  });
});

describe("universal retention registry (PRV-006, shared with #1766)", () => {
  it("covers mas_messages, screener_runs and research_runs with a 30-day bound", () => {
    for (const table of ["mas_messages", "screener_runs", "research_runs"]) {
      const rule = retentionRuleFor(table);
      expect(rule).toBeDefined();
      expect(rule?.maxAgeDays).toBe(30);
      expect(PRIVACY_RETENTION_TABLES).toContain(table);
    }
  });

  it("an unknown table has no rule — it is not silently invented", () => {
    expect(retentionRuleFor("no_such_table")).toBeUndefined();
  });
});

describe("privacy routes", () => {
  const prefsStore = new Map<string, PrivacyPreferences>();

  it("export requires a session (401) and returns only the caller's own data", async () => {
    const anon = await handlePrivacyExportRoute({
      session: null,
      method: "GET",
      subject: SUBJECT,
      loadExport: async () => buildExportPayload({ subject: SUBJECT, generatedAt: 1 }),
    });
    expect(anon.status).toBe(401);
    const ok = await handlePrivacyExportRoute({
      session: { internalUserId: SUBJECT },
      method: "GET",
      subject: SUBJECT,
      loadExport: async () => buildExportPayload({ subject: SUBJECT, generatedAt: 1 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { subject: string }).subject).toBe(SUBJECT);
  });

  it("status reports the ADMT notice, GPC state, and stored preferences", async () => {
    const res = await handlePrivacyStatusRoute({
      session: { internalUserId: SUBJECT },
      method: "GET",
      secGpcHeader: "1",
      preferences: { saleSharingOptOut: false, admtOptOut: false },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gpcOptOut: boolean;
      preferences: PrivacyPreferences;
      admtNotice: { effectiveRoute: string };
    };
    expect(body.gpcOptOut).toBe(true);
    // GPC on the request forces the effective preferences on, in the response.
    expect(body.preferences.saleSharingOptOut).toBe(true);
    expect(body.admtNotice.effectiveRoute).toBe("static");
  });

  it("preferences POST stores only the caller's own preferences; GET returns them", async () => {
    const post = await handlePrivacyPreferencesRoute({
      session: { internalUserId: SUBJECT },
      method: "POST",
      subject: SUBJECT,
      secGpcHeader: null,
      body: { admtOptOut: true },
      load: async () => prefsStore.get(SUBJECT) ?? { saleSharingOptOut: false, admtOptOut: false },
      save: async (_subject, prefs) => {
        prefsStore.set(SUBJECT, prefs);
      },
    });
    expect(post.status).toBe(200);
    expect(prefsStore.get(SUBJECT)?.admtOptOut).toBe(true);
    const get = await handlePrivacyPreferencesRoute({
      session: { internalUserId: SUBJECT },
      method: "GET",
      subject: SUBJECT,
      secGpcHeader: null,
      body: null,
      load: async () => prefsStore.get(SUBJECT) ?? { saleSharingOptOut: false, admtOptOut: false },
      save: async () => {},
    });
    expect((await get.json() as { preferences: PrivacyPreferences }).preferences.admtOptOut).toBe(true);
  });

  it("erasure requires a session, runs the cascade, and never erases another subject", async () => {
    const legs = [memoryLeg("session", [SUBJECT, OTHER])];
    const anon = await handlePrivacyErasureRoute({
      session: null,
      method: "POST",
      subject: SUBJECT,
      legs,
    });
    expect(anon.status).toBe(401);
    const ok = await handlePrivacyErasureRoute({
      session: { internalUserId: SUBJECT },
      method: "POST",
      subject: SUBJECT,
      legs,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { complete: boolean; residualTotal: number };
    expect(body.complete).toBe(true);
    expect(body.residualTotal).toBe(0);
    expect(legs[0].rows).toEqual([OTHER]);
  });

  it("erasure with a deferred leg returns 200 with complete=false, never a false pass", async () => {
    const res = await handlePrivacyErasureRoute({
      session: { internalUserId: SUBJECT },
      method: "POST",
      subject: SUBJECT,
      legs: [
        memoryLeg("session", [SUBJECT]),
        { name: "vectorize", deferred: "no per-subject vector key on current main" } as ErasureLeg,
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { complete: boolean; deferred: string[] };
    expect(body.complete).toBe(false);
    expect(body.deferred).toContain("vectorize");
  });
});
