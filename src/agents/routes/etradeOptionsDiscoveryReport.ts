/**
 * Discovery report download helper, moved out of
 * src/agents/routes/etradeOptions.ts — that file sits 90 B under the
 * #359 50 KB ratchet on main, so unpinned private helpers live in
 * sibling modules and the dispatcher keeps only the call (the #995
 * split pattern). Behaviour is unchanged: same key lookup, same
 * content types, same error shapes. No route conditions, no
 * ETradeService construction, no universe-deps call — no pin
 * in the route inventory, the construction ledger, or the
 * provider-capture suite observes this move.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

export async function serveDiscoveryReport(
  request: Request,
  ctx: EtradeOptionsRouteContext,
  format: "pdf" | "xlsx" | "csv",
): Promise<Response> {
  const userLogin = request.headers.get("x-user-login");
  if (!userLogin) return unauthenticatedResponse();
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const label = format.toUpperCase();
  if (!key) {
    return Response.json({ error: `No discovery report ${label} key supplied` }, { status: 400 });
  }
  try {
    const file = await ctx.getScreenerAgent(userLogin).getDiscoveryReportByKey(key);
    if (!file) {
      return Response.json({ error: `No discovery report ${label} available yet` }, { status: 404 });
    }
    const contentType =
      format === "pdf"
        ? "application/pdf"
        : format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv";
    return new Response(file.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Content-Length": String(file.bytes.length),
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : `Failed to load discovery report ${label}` },
      { status: 500 },
    );
  }
}
