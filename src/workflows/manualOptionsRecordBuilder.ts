/**
 * The manual screen's canonical record builder, as a leaf module.
 *
 * Issue #4066: `createManualOptionsRecordBuilder` used to live in
 * `./manualOptionsScreen`, whose graph reaches the report pipeline
 * (`unifiedReportPipeline` -> `report-asset-agent` -> `@cloudflare/think`,
 * whose workerd-only imports break the client build) — and the per-stage
 * control module (`./optionsStageControl`) is reachable from the client
 * bundle through the NLQ execution module. The builder itself needs only
 * the tenant-provider provenance, so it lives here with its two small
 * helpers; `./manualOptionsScreen` re-exports it, so its existing
 * callers (the manual route) are unchanged.
 */
import { resolveTenantProviders } from "../services/tenantProviders";
import {
  resolveTenantProviderContext,
  withProviderProvenance,
} from "../services/optionsProviderContext";
import type { OptionScreenerFilter } from "../types";
import type { UnifiedOptionsRunRecord } from "../services/optionsServeRecord";

/** The ctx slice the manual delivery needs (structural - the route's ctx satisfies it). */
export interface ManualOptionsScreenCtx {
  env: unknown;
  getOrm(): {
    storeCanonicalReport: (
      input: unknown,
      env?: unknown,
    ) => { reportId: string; created: boolean } | null;
  };
  ensureTables(): unknown;
  getScreenerAgent(userLogin?: string): {
    getPdfByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    getOptionsXlsxByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    getOptionsCsvByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    generateAndStoreOptionsXlsx(result: unknown): Promise<{ key: string; fileName: string }>;
    generateAndStoreOptionsCsv(result: unknown): Promise<{ key: string; fileName: string }>;
  };
  scheduleScreenerFollowups?: (
    outcome: unknown,
    userLogin: string,
  ) => Promise<void>;
}

export function symbolsLabel(filter: OptionScreenerFilter, universeLabel?: string): string {
  return (filter.underlyingSymbols || []).join(", ") || universeLabel || "selected underlyings";
}

export function countsSummary(result: Record<string, unknown>): string {
  return `${result["totalUnderlyingsScanned"] ?? 0} underlyings scanned, ${result["totalContractsEvaluated"] ?? 0} contracts evaluated, ${result["matchedCount"] ?? 0} matched.`;
}

/**
 * The route's pinned canonical record, built by the persist stage.
 * The provenance resolves fail-open (etrade/etrade) like the route's
 * slice-2 read. The filter + result + provenance ride the FIRST write:
 * the artifact-key backfill (#2602) fills only key/status/error fields,
 * so a later re-record cannot add them.
 */
export function createManualOptionsRecordBuilder(ctx: ManualOptionsScreenCtx): (
  input: {
    runId: string;
    userLogin: string;
    request: { classInput?: { request?: { filter?: unknown } } };
    screen: { result: Record<string, unknown> };
  },
) => Promise<UnifiedOptionsRunRecord> {
  return async (input) => {
    const filter = (input.request.classInput?.request?.filter ?? {}) as OptionScreenerFilter;
    const provenance = withProviderProvenance(
      {},
      resolveTenantProviderContext(await resolveTenantProviders(ctx.env as never)),
    );
    return {
      runId: input.runId,
      generationId: input.runId,
      title: `Options contract screen — ${symbolsLabel(filter)}`,
      source: "options_scanner",
      summary: countsSummary(input.screen.result),
      trigger: "manual",
      userLogin: input.userLogin,
      filter,
      result: input.screen.result,
      provenance,
    };
  };
}
