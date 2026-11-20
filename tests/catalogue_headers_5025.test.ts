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
    expect(D1_CATALOGUE_ENTRIES.length).toBe(237);
    expect(ORM_CATALOGUE_ENTRIES.length).toBe(26);
    expect(REMAINDER_CATALOGUE_ENTRIES.length).toBe(64);
    expect(DO_CATALOGUE_ENTRIES.length).toBe(109);
  });

  it("exposes createSessionMembershipStore as an alias for createKvMembershipStore", () => {
    expect(createSessionMembershipStore).toBe(createKvMembershipStore);
  });
});
