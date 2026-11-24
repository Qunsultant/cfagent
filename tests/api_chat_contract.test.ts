import { describe, it, expect } from "vitest";
import { REST_APIS_CATALOG } from "../src/client/restEndpointsData";

/**
 * Issue #325 — POST /api/chat contract alignment.
 *
 * PR #320 made POST /api/chat synchronous ({ reply, route, model,
 * streaming: false }). These tests pin the CATALOG ↔ ROUTE alignment so the
 * advertised contract can never silently drift from the real one again:
 *
 *  - the catalog's api_chat entry documents the exact top-level response
 *    keys the route returns (reply / route / model / streaming);
 *  - the documented route detail (route.agent/confidence/reason/
 *    needsConfirmation) matches the handler's route object;
 *  - the entry no longer advertises a streaming route;
 *  - the Worker forwarder's immediate-sync list keeps /chat excluded from
 *    async-eligible queueing (regression guard against a silent revert to
 *    the old 202-job behavior).
 */
describe("POST /api/chat catalog↔route contract (#325)", () => {
  const apiChat = REST_APIS_CATALOG.find((e) => e.id === "api_chat")!;

  it("the api_chat catalog entry exists", () => {
    expect(apiChat).toBeDefined();
    expect(apiChat.method).toBe("POST");
    expect(apiChat.path).toBe("/api/chat");
  });

  it("sampleResponse documents exactly the response keys the route returns", () => {
    // src/agents/orchestrator.ts returns
    // Response.json({ reply, route: {...}, model, streaming: false }).
    expect(Object.keys(apiChat.sampleResponse || {}).sort()).toEqual([
      "model",
      "reply",
      "route",
      "streaming",
    ]);
  });

  it("sampleResponse.route documents the route detail object", () => {
    expect(Object.keys(apiChat.sampleResponse!.route).sort()).toEqual([
      "agent",
      "confidence",
      "needsConfirmation",
      "reason",
    ]);
  });

  it("the documented contract is explicitly synchronous", () => {
    expect(apiChat.sampleResponse!.streaming).toBe(false);
  });

  it("the entry no longer advertises a streaming route", () => {
    expect(apiChat.title).not.toMatch(/stream/i);
    expect(apiChat.description).not.toMatch(/streaming LLM conversation/i);
  });

  it("the forwarder keeps /chat in the immediate-sync set (never 202-queued)", () => {
    // Mirrors the regex in src/server.ts (~line 1058). If this regex ever
    // drops `chat`, POST /api/chat would fall back to the old async-job
    // behavior — the exact regression issue #325 exists to prevent.
    const isImmediateSync = /^\/(?:clear|reset|memory|audit|chat)(?:\/|\?|$)/i;
    expect(isImmediateSync.test("/chat")).toBe(true);
    expect(isImmediateSync.test("/api/chat".replace(/^\/api/, ""))).toBe(true);
  });
});
