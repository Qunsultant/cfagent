/**
 * Issue #5699 — one JSON shape for HTTP 401s, and a pin that it stays that way.
 *
 * Thirteen bare-text refusals (`new Response("Unauthorized")`) coexisted with
 * JSON ones in the same server. A client that parses JSON reads the bare body
 * as a parser crash — the #5625 failure. The WebSocket upgrade refusal is the
 * documented exception: the handshake body is not parsed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  UNAUTHORIZED_CODE,
  UNAUTHORIZED_MESSAGE,
  unauthorizedJson,
} from "../src/server/routes/apiRefusals";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const repoPath = (file: string) => relative(process.cwd(), file).split(sep).join("/");

describe("Issue #5699 — JSON 401s", () => {
  it("answers a JSON body with a stable code and the default message", async () => {
    const res = unauthorizedJson();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe(UNAUTHORIZED_CODE);
    expect(body.error).toBe(UNAUTHORIZED_MESSAGE);
  });

  it("keeps a caller's specific message", async () => {
    const res = unauthorizedJson("Unauthorized: sign in to approve a trade.");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("approve a trade");
  });

  it("has no bare-text 401 left in the HTTP routes (the WS upgrade is the one exception)", () => {
    // Comments may mention the idiom; only a code line counts.
    const offenders = [...sourceFiles("src/server"), ...sourceFiles("src/agents")]
      .filter((file) =>
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .some((line) => line.trim().startsWith('return new Response("Unauthorized')),
      )
      .map(repoPath);

    expect(offenders).toEqual([]);
  });

  it("keeps the WebSocket upgrade refusal as text, and says why", () => {
    const ws = readFileSync("src/api/wsRoutes.ts", "utf8");
    expect(ws).toContain('new Response("Unauthorized", { status: 401 })');
  });
});
