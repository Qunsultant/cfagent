/**
 * Issue #359-12: watchlists routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous E*TRADE watchlists block (between the E*TRADE options
 * delegation and the Alpaca block):
 *   GET         /etrade/watchlists
 *   GET         /etrade/watchlist/details
 *   POST        /etrade/watchlist/create
 *   POST        /etrade/watchlist/save-screen
 *   DELETE|POST /etrade/watchlist/delete
 *
 * The block was contiguous in routeRequest, so this module exports ONE
 * handler invoked from routeRequest at the EXACT position the original
 * blocks occupied in the sequential matching sequence. It returns a Response
 * when one of its paths matches, or null when none does (the orchestrator
 * then continues its sequential matching).
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * WatchlistsRouteContext parameter; there are no new globals and no
 * back-references into the class. The requestedEnv binding stays inline in
 * routeRequest and is passed through the context.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { ETradeService } from "../../services/etrade";
import {
  brokerFailureResponse,
  genericBrokerFailureResponse,
} from "./brokerCodedError";
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";

/** The subset of OrchestratorAgent surface the E*TRADE watchlists handlers need. */
export interface WatchlistsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Requested E*TRADE environment (owner: routeRequest local - stays inline;
   * passed through here). */
  requestedEnv: "TEST" | "PROD" | undefined;
}

/**
 * E*TRADE Watchlist Endpoints & Persistence. Invoked from routeRequest at the
 * exact position the original blocks occupied; returns a Response when one
 * of the watchlist paths matches, or null to continue sequential matching.
 */
export async function handleWatchlistsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: WatchlistsRouteContext
): Promise<Response | null> {
    // E*TRADE Watchlist Endpoints & Persistence

    // List Watchlists (E*TRADE REST + Durable SQLite)
    if (path.endsWith("/etrade/watchlists") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        let watchlists;
        try {
          watchlists = await etrade.getWatchlists();
        } catch (err) {
          // Issue #826: BusinessError carries business message for UI.
          const { BusinessError } = await import("../../outcomes/outcomeAspects");
          if (err instanceof BusinessError) {
            return Response.json(err.toJSON(), { status: err.entry?.httpStatus ?? 500 });
          }
          throw err;
        }
        if (watchlists.length === 0) {
          // Issue #243: the merged remote+local list is empty AND the
          // client recorded an error — that is an upstream failure, not
          // "you have no watchlists": 502 naming the cause (#155
          // pattern). A genuine empty (no recorded error) keeps the
          // exact previous 200 payload; a non-empty merged list (e.g.
          // local durable watchlists while the remote read failed) is
          // real data and is served exactly as before.
          // Issue #2573: coded form, not the raw lastError string.
          const codedFailure = brokerFailureResponse(etrade, "watchlists");
          if (codedFailure) return codedFailure;
        }
        return Response.json({ count: watchlists.length, watchlists });
      } catch (err) {
        return genericBrokerFailureResponse();
      }
    }

    // Get Watchlist Details
    if (path.endsWith("/etrade/watchlist/details") && request.method === "GET") {
      try {
        const id = url.searchParams.get("id") || url.searchParams.get("name") || "";
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const details = await etrade.getWatchlistDetails(id);
        if (!details) {
          // Issue #243: a null with a recorded client error is an
          // upstream failure (expired session, missing credentials),
          // not a missing watchlist — 502 naming the cause. Only a
          // genuine not-found (no recorded error) keeps the 404.
          // Issue #2573: coded form, not the raw lastError string.
          const codedFailure = brokerFailureResponse(etrade, "watchlists");
          if (codedFailure) return codedFailure;
          return Response.json({ error: `Watchlist '${id}' not found` }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return genericBrokerFailureResponse();
      }
    }

    // Create Watchlist
    if (path.endsWith("/etrade/watchlist/create") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Default Watchlist").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const res = await etrade.createWatchlist({ name, symbols });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create watchlist" }, { status: 500 });
      }
    }

    // Save Screen Results directly as Watchlist
    if (path.endsWith("/etrade/watchlist/save-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Screener Results").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const items = body.items || [];
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const res = await etrade.saveScanAsWatchlist(name, symbols, items);
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save screen as watchlist" }, { status: 500 });
      }
    }

    // Delete Watchlist
    if (path.endsWith("/etrade/watchlist/delete") && (request.method === "DELETE" || request.method === "POST")) {
      try {
        const id = url.searchParams.get("id") || (await request.json().catch(() => ({})) as any)?.id;
        if (!id) return Response.json({ error: "Missing watchlist id" }, { status: 400 });
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const deleted = await etrade.deleteWatchlist(id);
        return Response.json({ success: deleted, deletedId: id });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete watchlist" }, { status: 500 });
      }
    }

  return null;
}
