/**
 * ReportAssetAgent (issue #680).
 *
 * Single owner for the Generate step of the generate/store/serve/deliver
 * model. All PDF asset generation flows through here — no caller generates
 * inline anymore.
 *
 * - Accepts a generation request (asset type + canonical data).
 * - Renders via the trading PDF renderers (one call site per type).
 * - Stores via reportBlobStore (R2 when bound, DO-storage otherwise).
 * - Returns the storage key + filename.
 *
 * Best-effort: generation failure returns null, never throws — the run
 * that requested the asset must not fail because rendering did.
 */

import { PortThink } from "../actors/thinkAdapter";
import {
  dispatchReportAssetA2A,
  reportAssetA2AOutcome,
  type ReportAssetA2AOutcome,
} from "./reportAssetA2aDispatch";
import type { ScreenerPdfOptions } from "../trading";
import type { Env } from "../types";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { putReportPdf } from "../services/reportBlobStore";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/report-asset-agent",
});

export type AssetType = "research" | "screener" | "options";

export interface AssetRequest {
  type: AssetType;
  /** Canonical data the renderer consumes (never a second copy). */
  data: unknown;
  /** Optional storage key; defaults to `report:pdf:<type>:<uuid>`. */
  key?: string;
  /** Optional filename override; defaults to the #297 convention. */
  fileName?: string;
  /** User scope for the storage namespace. */
  userLogin?: string;
  /** Issue #2088: PDF options, threaded to the screener generator. */
  pdfOptions?: ScreenerPdfOptions;
}

export interface AssetResult {
  key: string;
  fileName: string;
}

/**
 * One stored asset's metadata, as listed by listAssets (#2349):
 * the storage key plus the fileName/storedAt pair every asset
 * record carries (reportBlobStore's ReportPdfMeta). Metadata only —
 * asset bytes never ride a listing.
 */
export interface ReportAssetMeta {
  key: string;
  fileName: string;
  storedAt: string;
}

/**
 * Issue #1958 (think-fleet, tracker #1951, shape (a)): this class
 * extends PortThink instead of Agent. It has no chat turn and no port
 * hooks of its own — nothing here drives a turn, so there is no hook
 * to preserve or translate; the PortThink protocol (one-shot
 * override, hook-order recording, synchronous onChatError text) is
 * inherited untouched, and any future turn would go through the
 * Think adapter, which owns the lifecycle boot (await
 * think.lifecycle.start() before any turn). The RPC surface below
 * (generateAsset/getAsset) is unchanged: Think extends Agent, so
 * this.ctx.storage and this.env behave exactly as before.
 */
export class ReportAssetAgent extends PortThink {
  /**
   * Generate + store one PDF asset. Returns null on any failure.
   *
   * Consolidation C4 (issue #1329, epic #1151): the agent no longer
   * calls the trading generators directly — it dispatches through the
   * pipeline's generateReportPdf/getReportFileName (the ONE generator
   * dispatch, src/services/unifiedReportPipeline.ts), completing the
   * epic's "report-asset-agent's direct PDF call moves behind
   * runReportPipeline" item. The agent remains the single owner of
   * the generate step; the pipeline owns the dispatch.
   */
  async generateAsset(request: AssetRequest): Promise<AssetResult | null> {
    try {
      const { type, data } = request;
      const { generateReportPdf, getReportFileName } = await import("../services/unifiedReportPipeline");
      const bytes = await generateReportPdf(type, data, request.pdfOptions);
      const fileName = request.fileName ?? (await getReportFileName(type, data));

      const key =
        request.key ?? `report:pdf:${type}:${crypto.randomUUID().slice(0, 8)}`;
      const storage = {
        put: async (k: string, v: unknown) => {
          await (this.ctx.storage as any).put(k, v);
        },
        get: async (k: string) => (await (this.ctx.storage as any).get(k)) ?? null,
      };
      await putReportPdf(this.env, storage as any, key, fileName, bytes);
      return { key, fileName };
    } catch (err) {
      structuredLog.warn("reportAssetAgent.generate_asset_failed", {
        message: `[ReportAssetAgent] generateAsset(${request.type}) failed:`,
        type: request.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * List this instance's stored assets, newest first (#2349, mesh
   * G1 batch B: the chat door's list half). Every asset this
   * instance generated wrote a metadata record under its storage
   * key (reportBlobStore's ReportPdfMeta: fileName + storedAt,
   * with the bytes in R2 or as a legacy base64 field); a record is
   * an asset exactly when it carries that pair, so non-asset
   * records sharing the storage are skipped. Metadata only — the
   * listing never loads or returns asset bytes.
   */
  async listAssets(limit = 50): Promise<ReportAssetMeta[]> {
    const listed = await this.ctx.storage.list();
    const assets: ReportAssetMeta[] = [];
    for (const [key, value] of listed) {
      const meta = value as { fileName?: unknown; storedAt?: unknown } | null;
      if (meta && typeof meta.fileName === "string" && typeof meta.storedAt === "string") {
        assets.push({ key, fileName: meta.fileName, storedAt: meta.storedAt });
      }
    }
    assets.sort((a, b) => b.storedAt.localeCompare(a.storedAt));
    const cap = Math.max(1, Math.min(Math.trunc(limit) || 50, 200));
    return assets.slice(0, cap);
  }

  /**
   * Fetch a stored asset by key.
   */
  async getAsset(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      const storage = {
        put: async (k: string, v: unknown) => {
          await (this.ctx.storage as any).put(k, v);
        },
        get: async (k: string) => (await (this.ctx.storage as any).get(k)) ?? null,
      };
      return await getReportPdf(this.env, storage as any, key);
    } catch (err) {
      structuredLog.warn("reportAssetAgent.get_asset_failed", {
        message: `[ReportAssetAgent] getAsset(${key}) failed:`,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Issue #2223 (final slice): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the hyphenated "report-asset"
   * name to this class on the service instance "default" and calls
   * this with the parsed body + origin (a Request cannot cross the
   * DO RPC boundary). Thin delegation to the dispatch module
   * (./reportAssetA2aDispatch), which threads the service identity
   * as generated assets' user scope; the methods' null failure
   * signal surfaces as an honest failure there, never a success.
   * Returns the collected { text, data } outcome.
   */
  async handleA2A(body: unknown, origin: string): Promise<ReportAssetA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchReportAssetA2A(this.env, body, {
      executor: {
        generateAsset: (request) => this.generateAsset(request),
        getAsset: (key) => this.getAsset(key),
        listAssets: (limit) => this.listAssets(limit),
      },
    });
    return reportAssetA2AOutcome(data);
  }
}

/**
 * Helper for callers: get the ReportAssetAgent for a user and generate.
 * The agent name is stable per user so assets are namespaced.
 */
export function reportAssetAgentName(userLogin: string, serviceUserLogin?: string | null): string {
  // Issue #1185: the bare "default" instance name belongs to the
  // configured service identity — the only login that maps to it.
  return serviceUserLogin && userLogin === serviceUserLogin
    ? "default"
    : `assets:${userLogin}`;
}

/**
 * Generate one PDF asset via the ReportAssetAgent DO.
 * Returns the storage key + filename, or null on any failure.
 * This is the single entry point all callers use (issue #680).
 */
export async function generatePdfAsset(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  type: AssetType,
  data: unknown,
  pdfOptions?: ScreenerPdfOptions
): Promise<AssetResult | null> {
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    if (!ns) {
      // Issue #912: was silent — log why PDF generation is skipped.
      structuredLog.error("reportAssetAgent.generate_pdf_asset_skipped_no_binding", {
        message: `[ReportAssetAgent] generatePdfAsset(${type}) skipped: REPORT_ASSET_AGENT binding not configured in worker env. PDF will not be generated.`,
        type,
      });
      return null;
    }
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    return await agent.generateAsset({ type, data, userLogin, pdfOptions });
  } catch (err) {
    structuredLog.warn("reportAssetAgent.generate_pdf_asset_failed", {
      message: `[ReportAssetAgent] generatePdfAsset(${type}) failed:`,
      type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Generate + fetch the bytes back (for callers that need the bytes inline,
 * e.g. Slack delivery). Returns null on any failure.
 */
export async function generatePdfAssetWithBytes(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  type: AssetType,
  data: unknown,
  pdfOptions?: ScreenerPdfOptions
): Promise<{ key: string; fileName: string; bytes: Uint8Array } | null> {
  const asset = await generatePdfAsset(env, userLogin, type, data, pdfOptions);
  if (!asset) return null;
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    const stored = await agent.getAsset(asset.key);
    if (!stored) return null;
    return { key: asset.key, fileName: asset.fileName, bytes: stored.bytes };
  } catch {
    return null;
  }
}

/**
 * Fetch a stored asset by key via the ReportAssetAgent DO.
 */
export async function getPdfAsset(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  key: string
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    if (!ns) return null;
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    return await agent.getAsset(key);
  } catch (err) {
    structuredLog.warn("reportAssetAgent.get_pdf_asset_failed", {
      message: `[ReportAssetAgent] getPdfAsset(${key}) failed:`,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
