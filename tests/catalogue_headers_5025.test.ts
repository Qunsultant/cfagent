/**
 * Pinning test for #5025 — Catalogue headers, barrel, and counts.
 */
import { describe, expect, it } from "vitest";
import {
  D1_CATALOGUE_ENTRIES,
  DO_CATALOGUE_ENTRIES,
  DO_DML_CATALOGUE_ENTRIES,
  ORM_CATALOGUE_ENTRIES,
  REMAINDER_CATALOGUE_ENTRIES,
  buildDoDmlCatalogue,
  executeDoDml,
} from "../src/data/schemaComponent";
import {
  createKvMembershipStore,
  createSessionMembershipStore,
} from "../src/security/iaaaMembershipStore";

describe("#5025 schemaComponent barrel & membership store naming", () => {
  it("exports DO DML modules from schemaComponent barrel", () => {
    expect(Array.isArray(DO_DML_CATALOGUE_ENTRIES)).toBe(true);
    expect(DO_DML_CATALOGUE_ENTRIES.length).toBeGreaterThan(0);
    expect(typeof buildDoDmlCatalogue).toBe("function");
    expect(typeof executeDoDml).toBe("function");
  });

  it("reconciles live catalogue entry counts", () => {
    // #4767 adds migrations 0071/0072 (4 D1 ALTERs + 4 remainder ALTERs):
    // D1 225 → 229, remainder 57 → 61.
    // #4204 adds migration 0073 (D1 job_run_records recent-read index):
    // D1 229 → 230.
    // #5865 adds migration 0074 (definition history) to both residencies:
    // D1 230 → 234 (table + backfill + #5887's two ALTERs), DO 107 → 108,
    // remainder 57 → 63 (#4767 + #5887).
    // #3185 (stamp slice): DO 108 → 109 (usage_events tenant index),
    // remainder 63 → 64 (usage_events tenant_id ALTER).
    // #3185 bridge adds migration 0077 (agent_usage_events mirror
    // table + 2 indexes): D1 234 → 237.
    // #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): D1 237 → 238.
    // #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): D1 238 → 240.
    // #6072 adds migration 0080 (agent_screener_task_entries
    // table): D1 240 → 241. #6099 adds migration 0081
    // (job_run_records tenant_id + projected_at_ms + unique
    // identity index): D1 241 → 244.
    // #6141 adds migration 0082 (referral trial-extension: 6 rule
    // columns + ledger table + 2 indexes): D1 244 → 255.
    // #6167 adds one probed DO ALTER (mas_async_jobs.host_version):
    // remainder 64 → 65.
    // Issue #5102 (F5 of #5094) adds migration 0084 (job_run_records
    // binding columns: 4 ALTERs + 1 index): D1 255 → 260.
    expect(D1_CATALOGUE_ENTRIES.length).toBe(260);
    expect(ORM_CATALOGUE_ENTRIES.length).toBe(26);
    // Issue #6167 adds 1 remainder entry (mas_async_jobs.host_version):
    // 64 → 65. Issue #5100 (F3 of #5094) adds 13 remainder entries (4
    // job_run_records + 4 mas_trades + 5 mas_policy_verdicts literal
    // ALTERs): 65 → 78.
    expect(REMAINDER_CATALOGUE_ENTRIES.length).toBe(85);
    expect(DO_CATALOGUE_ENTRIES.length).toBe(109);
  });

  it("exposes createSessionMembershipStore as an alias for createKvMembershipStore", () => {
    expect(createSessionMembershipStore).toBe(createKvMembershipStore);
  });
});
