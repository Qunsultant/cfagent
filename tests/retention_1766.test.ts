/**
 * Issue #1766 (parent #1717, F-37 / F-38 / F-41 / F-58): universal
 * retention registry extension, orphan sweep planner, DO SQLite
 * snapshot export manifest, and purge-run audit events.
 *
 * TDD red-first: this file was written before src/data/retention1766.ts
 * existed and before the privacyDsar registry was extended, and was
 * observed failing on the missing module + the unextended registry.
 *
 * The registry corrections pinned here are deliberate, with evidence
 * in the §9 PR body:
 * - mas_messages is 90d, NOT the 30d #1765's registry comment claimed:
 *   src/security/storageRetention.ts defaults the nightly pass to 90d
 *   (STORAGE_RETENTION_DEFAULT_DAYS) and the UI advertises 90d. The
 *   registry is declarative today (no enforcement reads it), so
 *   correcting the declaration changes zero runtime behavior.
 * - screener_runs is the assessment's LOGICAL name: its physical stores
 *   (mas_opportunity_scans / mas_discovery_runs) already enforce
 *   365d + row caps at source (C4 run-store contract). The logical
 *   30d target is carried, not enforced, until an owner product
 *   decision aligns the two.
 * - research_runs is carried at 30d, not enforced: the track-record
 *   feed reads research_runs directly (ResearchAgent.getTrackRecord),
 *   so pruning would truncate track history — enforcement needs a
 *   track-record source decision first (named follow-up).
 */
import { describe, expect, it } from "vitest";
import {
  PRIVACY_RETENTION_TABLES,
  retentionRegistry,
  retentionRuleFor,
  retentionRules,
} from "../src/privacy/privacyDsar";
import {
  buildPurgeAuditEventInput,
  buildSnapshotManifest,
  planOrphanSweep,
  resolveOrphanSweepDelete,
  resolveSnapshotEnabled,
  snapshotObjectKey,
  truncateSnapshotRows,
} from "../src/data/retention1766";

describe("universal retention registry (#1766 extends #1765)", () => {
  it("keeps the #1765 privacy tables registered", () => {
    for (const table of PRIVACY_RETENTION_TABLES) {
      expect(retentionRuleFor(table)).toBeDefined();
    }
    expect(PRIVACY_RETENTION_TABLES).toEqual([
      "mas_messages",
      "screener_runs",
      "research_runs",
    ]);
  });

  it("records mas_messages at the enforced 90d window (correcting #1765's 30d claim)", () => {
    const rule = retentionRuleFor("mas_messages");
    expect(rule?.action).toBe("bound");
    expect(rule?.maxAgeDays).toBe(90);
    expect(rule?.enforcement).toBe("enforced");
  });

  it("carries screener_runs at the declared 30d target over its 365d+caps physical stores", () => {
    const rule = retentionRuleFor("screener_runs");
    expect(rule?.action).toBe("bound");
    expect(rule?.maxAgeDays).toBe(30);
    expect(rule?.enforcement).toBe("carried");
    expect(rule?.physicalTables).toContain("mas_opportunity_scans");
    expect(rule?.physicalTables).toContain("mas_discovery_runs");
  });

  it("carries research_runs at 30d, unenforced until the track-record source decision", () => {
    const rule = retentionRuleFor("research_runs");
    expect(rule?.action).toBe("bound");
    expect(rule?.maxAgeDays).toBe(30);
    expect(rule?.enforcement).toBe("carried");
  });

  it("bounds agent_shard_jobs at 30d + 500-row cap (operator purge, #1701)", () => {
    const rule = retentionRuleFor("agent_shard_jobs");
    expect(rule?.action).toBe("bound");
    expect(rule?.maxAgeDays).toBe(30);
    expect(rule?.capRows).toBe(500);
    expect(rule?.enforcement).toBe("enforced");
  });

  it("keeps financial and report records with reasons, never silently", () => {
    for (const table of ["mas_transactions", "mas_trades", "mas_reports"]) {
      const rule = retentionRuleFor(table);
      expect(rule?.action).toBe("keep");
      expect(rule?.reason.length).toBeGreaterThan(0);
    }
  });

  it("covers every table in the recorded decision inventory", () => {
    const inventory = [
      "mas_messages",
      "mas_events",
      "mas_memory",
      "mas_transactions",
      "mas_trades",
      "mas_reports",
      "mas_policy_verdicts",
      "mas_watchlists",
      "mas_referrals",
      "mas_ads",
      "mas_external_ads",
      "mas_categories",
      "mas_options_chain_cache",
      "mas_job_outcomes",
      "mas_async_jobs",
      "mas_report_confirmations",
      "mas_autopilot",
      "mas_settings",
      "mas_opportunity_scans",
      "mas_discovery_runs",
      "mas_screener_presets",
      "paused_schedules",
      "cf_agents_jobs",
      "usage_events",
      "screener_runs",
      "research_runs",
      "research_task_store",
      "research_settings",
      "research_evaluations",
      "agent_chains",
      "agent_synthesized_schedules",
      "agent_shard_jobs",
      "agent_chain_audit",
      "agent_reports",
      "agent_governance",
      "agent_market_nodes",
      "agent_market_edges",
      "agent_thesis_realizations",
      "agent_calibration_decisions",
      "mas_adaptation_audit",
      "mas_candidate_evaluations",
      "mas_improvement_candidates",
      "mas_learnings",
      "mas_promotion_approvals",
      "mas_promotion_gate_verdicts",
      "mas_promotions",
      "mas_strategy_reviews",
      "mas_strategy_weights",
      "mas_strategy_weight_caps",
      "mas_strategy_gates",
    ];
    for (const table of inventory) {
      expect(retentionRuleFor(table)).toBeDefined();
    }
    expect(retentionRegistry().length).toBeGreaterThanOrEqual(inventory.length);
    expect(retentionRules().length).toBe(retentionRegistry().length);
  });

  it("every rule is well-formed: bound has a positive window, keep has a reason", () => {
    for (const rule of retentionRegistry()) {
      expect(rule.table.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(0);
      expect(rule.enforcementNote.length).toBeGreaterThan(0);
      if (rule.action === "bound") {
        expect(rule.maxAgeDays).toBeGreaterThan(0);
      } else {
        expect(rule.maxAgeDays).toBeNull();
      }
    }
  });

  it("an unknown table still has no rule — it is never silently purged", () => {
    expect(retentionRuleFor("no_such_table")).toBeUndefined();
  });
});

describe("orphan sweep planner (reports/*.json vs mas_reports.body_r2_key)", () => {
  it("finds orphan objects and dangling rows, scoped to reports/ only", () => {
    const plan = planOrphanSweep({
      bucketKeys: [
        "reports/a.json",
        "reports/b.json",
        "reports/c.json",
        "knowledge/cat/hash",
        "stocks/SPY/x.json",
      ],
      referencedKeys: ["reports/a.json", "reports/zzz.json", "knowledge/cat/hash"],
    });
    expect(plan.orphans).toEqual(["reports/b.json", "reports/c.json"]);
    expect(plan.danglingRows).toEqual(["reports/zzz.json"]);
    expect(plan.scanned).toBe(3);
    expect(plan.outOfScope).toBe(2);
    expect(plan.deleted).toEqual([]);
  });

  it("empty inputs produce an empty plan", () => {
    const plan = planOrphanSweep({ bucketKeys: [], referencedKeys: [] });
    expect(plan.orphans).toEqual([]);
    expect(plan.danglingRows).toEqual([]);
    expect(plan.scanned).toBe(0);
  });

  it("orphan delete is fail-closed: only the exact string 'true' enables it", () => {
    expect(resolveOrphanSweepDelete("true")).toBe(true);
    expect(resolveOrphanSweepDelete("false")).toBe(false);
    expect(resolveOrphanSweepDelete(undefined)).toBe(false);
    expect(resolveOrphanSweepDelete("yes")).toBe(false);
    expect(resolveOrphanSweepDelete("TRUE")).toBe(false);
  });
});

describe("DO SQLite snapshot export manifest", () => {
  it("keys snapshots by instance and UTC date", () => {
    expect(snapshotObjectKey("orchestrator", new Date("2026-11-02T04:00:00Z").getTime())).toBe(
      "snapshots/orchestrator/2026-11-02.json",
    );
  });

  it("truncates over-limit tables with a flag, never silently partial", () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    expect(truncateSnapshotRows(rows, 5)).toEqual({ rows, truncated: false });
    const cut = truncateSnapshotRows(rows, 2);
    expect(cut.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(cut.truncated).toBe(true);
  });

  it("builds a deterministic, content-sensitive manifest", async () => {
    const tables = [
      { table: "mas_messages", rows: [{ id: "m1" }] },
      { table: "mas_events", rows: [] },
    ];
    const first = await buildSnapshotManifest({
      instance: "orchestrator",
      exportedAt: 1_700_000_000_000,
      tables,
      rowLimit: 5000,
    });
    const second = await buildSnapshotManifest({
      instance: "orchestrator",
      exportedAt: 1_700_000_000_000,
      tables,
      rowLimit: 5000,
    });
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.tables[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tables[0].truncated).toBe(false);
    expect(first.tables[1].rowCount).toBe(0);
    const changed = await buildSnapshotManifest({
      instance: "orchestrator",
      exportedAt: 1_700_000_000_000,
      tables: [{ table: "mas_messages", rows: [{ id: "m2" }] }],
      rowLimit: 5000,
    });
    expect(changed.tables[0].sha256).not.toBe(first.tables[0].sha256);
    expect(changed.manifestSha256).not.toBe(first.manifestSha256);
  });

  it("snapshot stays enabled unless explicitly 'false' (fail-closed toward keeping backups)", () => {
    expect(resolveSnapshotEnabled(undefined)).toBe(true);
    expect(resolveSnapshotEnabled("true")).toBe(true);
    expect(resolveSnapshotEnabled("false")).toBe(false);
    expect(resolveSnapshotEnabled("garbage")).toBe(true);
  });
});

describe("purge-run audit events", () => {
  it("builds a valid IAAA audit input for an AgentDB purge run", () => {
    const input = buildPurgeAuditEventInput(
      {
        table: "agent_shard_jobs",
        tenantId: "tenant-1",
        cutoffMs: 1_700_000_000_000,
        agedPruned: 3,
        capPruned: 1,
        pruned: 4,
        capped: false,
        skipped: false,
      },
      { actorPrincipalId: "admin-1", tenantId: "tenant-1", nowMs: 1_700_000_100_000 },
    );
    expect(input.type).toBe("retention.purge");
    expect(input.action).toBe("retention.purge");
    expect(input.decision).toBe("allow");
    expect(input.outcome).toBe("succeeded");
    expect(input.actorType).toBe("human");
    expect(input.actorPrincipalId).toBe("admin-1");
    expect(input.tenantId).toBe("tenant-1");
    expect(input.policyVersion).toBe("iaaa-audit-1");
    expect(input.correlationId.length).toBeGreaterThan(0);
    expect(input.timestamp).toBe(1_700_000_100_000);
  });
});
