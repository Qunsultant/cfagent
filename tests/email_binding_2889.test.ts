/**
 * Issue #2889 (follow-up to Adapter S4 #1778, program #1717) — structural
 * pin on the EMAIL Email Sending binding.
 *
 * `src/services/cloudflareEmailSender.ts` calls `env.EMAIL.send` and its
 * factory returns null (fail-soft false) when the binding is absent, so
 * without a `send_email` declaration in `wrangler.jsonc` production sends
 * can never reach the real send path. This pin fails while the binding
 * is undeclared and passes once it is declared.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

describe("EMAIL Email Sending binding (#2889)", () => {
  it("wrangler.jsonc declares exactly one send_email binding named EMAIL", () => {
    // Wrangler 4 schema: send_email items carry `name` (the env binding
    // name), not `binding` — `binding` is rejected (additionalProperties
    // false, `name` required). The env key the code reads is EMAIL.
    const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
      send_email?: Array<{ name?: string }>;
    };
    const bindings = (wrangler.send_email ?? []).map((e) => e.name);
    expect(bindings).toEqual(["EMAIL"]);
  });
});
