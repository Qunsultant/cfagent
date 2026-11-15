/**
 * Manual screener-run event publication, extracted from etradeBroker.ts
 * (#1185 Phase C size remedy: etradeBroker.ts must stay under the #359
 * 50 KB module target enforced by tests/etrade_routes_resplit_995.test.ts).
 * etradeBroker.ts re-exports publishManualScreenerRun so existing imports
 * (etradeBrokerScreen.ts) are unchanged.
 */
import { publishScreenerCompleted, publishScreenerFailed } from "../../events/screenerPublishers";
import type { ScreenerRunResult } from "../screener-agent";
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { manualDeliveryIdentity } from "../../services/deliveryIdentity";

export async function publishManualScreenerRun(
  env: Env,
  orm: DatabaseORM,
  userLogin: string,
  result: ScreenerRunResult & { emailTo?: string },
): Promise<void> {
  const deps = { env, orm, userLogin };
  if (!result.success) {
    await publishScreenerFailed(deps, {
      type: "screener.failed",
      timestamp: result.timestamp,
      universe: result.universe,
      trigger: "manual",
      deliveryId: manualDeliveryIdentity({ timestamp: result.timestamp, universe: result.universe }),
      sector: result.sector,
      error: result.error || "E*TRADE unavailable",
      ...(result.emailTo ? { emailTo: result.emailTo } : {}),
    });
    return;
  }
  await publishScreenerCompleted(deps, {
    type: "screener.completed",
    timestamp: result.timestamp,
    universe: result.universe,
    trigger: "manual",
    expectedCount: result.expectedCount,
    pdfKey: result.pdfKey,
    pdfStatus: result.pdfStatus,
    pdfError: result.pdfError,
    deliveryId: manualDeliveryIdentity({ timestamp: result.timestamp, universe: result.universe }),
    sector: result.sector,
    totalScanned: result.totalScanned,
    matchedCount: result.matchedCount,
    opportunities: result.opportunities,
    ...(result.emailTo ? { emailTo: result.emailTo } : {}),
    ...(result.partial
      ? {
          partial: {
            quotedCount: result.partial.quotedCount,
            requestedCount: result.partial.requestedCount,
            failedSymbols: result.partial.failedSymbols,
            failureReasons: result.partial.failureReasons,
          },
        }
      : {}),
    ...(result.rejections?.length ? { rejections: result.rejections } : {}),
  });
}
