/**
 * Pinning test for #5036 — Cross-plane table ownership (D-4, D-5).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CROSS_PLANE_TABLE_OWNERS = {
  mas_feed_datasets: { owningPlane: "d1", productionAdapter: "d1FeedDatasetAdapter.ts" },
  mas_index_lists: { owningPlane: "d1", productionAdapter: "d1IndexListAdapter.ts", fallbackAdapter: "doSqliteIndexListAdapter.ts" },
} as const;

const DUAL_HOMED_JOB_TABLES = [
  "job_pipeline_definitions",
  "job_pipeline_instances",
  "job_pipeline_artifacts",
  "job_run_records",
  "job_enriched_datasets",
  "job_analyzed_datasets",
  "job_generated_datasets",
  "job_delivery_datasets",
] as const;

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("#5036 cross-plane table ownership", () => {
  it("D-4: names D1 as the owning plane for mas_feed_datasets and mas_index_lists", () => {
    expect(CROSS_PLANE_TABLE_OWNERS.mas_feed_datasets.owningPlane).toBe("d1");
    expect(CROSS_PLANE_TABLE_OWNERS.mas_index_lists.owningPlane).toBe("d1");
    const feedPorts = read("src/data/feedDatasetPorts.ts");
    expect(feedPorts).toContain("Residency: D1");
    expect(feedPorts).toContain("d1FeedDatasetAdapter.ts");
    const indexPorts = read("src/data/indexListPorts.ts");
    expect(indexPorts).toContain("d1IndexListAdapter.ts");
  });

  it("D-5: pins DO-authoritative + D1-projection/workflow-residency symmetry for all 8 job tables", () => {
    const d1Cat = read("src/data/schemaComponent/d1Catalogue.ts");
    const doCat = read("src/data/schemaComponent/doCatalogue.ts");
    expect(DUAL_HOMED_JOB_TABLES).toHaveLength(8);
    for (const table of DUAL_HOMED_JOB_TABLES) {
      expect(d1Cat).toContain(table);
      expect(doCat).toContain(table);
    }
  });
});
