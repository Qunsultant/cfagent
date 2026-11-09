/**
 * Tests for scripts/ci/deploy-worker.mjs (Issue #3789 / #3814).
 *
 * Verifies that:
 * 1. stripContainersConfig cleanly removes the "containers" configuration from wrangler.jsonc
 *    while preserving JSON validity, comments, and all other Durable Object bindings.
 * 2. isContainersForbiddenError accurately detects Cloudflare Containers 403 API errors.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  stripContainersConfig,
  isContainersForbiddenError,
} from "../scripts/ci/deploy-worker.mjs";

function stripJsoncComments(src: string): string {
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

describe("deploy-worker script helpers (#3789)", () => {
  it("stripContainersConfig removes the containers block from wrangler.jsonc", () => {
    const original = readFileSync("wrangler.jsonc", "utf8");
    expect(original).toContain('"containers"');

    const stripped = stripContainersConfig(original);
    expect(stripped).not.toContain('"containers"');
    expect(stripped).toContain('"SANDBOX_AGENT"');
    expect(stripped).toContain('"ORCHESTRATOR_AGENT"');
    expect(stripped).toContain('"ai_search_namespaces"');

    // Verify JSON validity of the stripped configuration
    const parsed = JSON.parse(stripJsoncComments(stripped)) as Record<string, unknown>;
    expect(parsed.containers).toBeUndefined();
    expect(parsed.name).toBe("ai-search-agent");
    expect(Array.isArray((parsed.durable_objects as any)?.bindings)).toBe(true);
  });

  it("isContainersForbiddenError detects Cloudflare Containers 403 Forbidden errors", () => {
    const sampleError = `
      Uploaded ai-search-agent (14.60 sec)
      ✘ [ERROR] ApiError: Forbidden
      url: 'https://api.cloudflare.com/client/v4/accounts/***/containers/applications/33833866526f4e68a1af1cd977385bd2',
      status: 403,
      statusText: 'Forbidden',
      body: { error: 'Authentication error' },
      request: {
        method: 'GET',
        url: '/applications/{application_id}',
        path: { application_id: '33833866526f4e68a1af1cd977385bd2' },
      }
    `;

    expect(isContainersForbiddenError(sampleError)).toBe(true);
  });

  it("isContainersForbiddenError returns false for unrelated deployment errors", () => {
    const buildError = `
      ✘ [ERROR] Could not resolve "some-missing-module"
      Build failed with 1 error
    `;
    expect(isContainersForbiddenError(buildError)).toBe(false);

    const emptyError = "";
    expect(isContainersForbiddenError(emptyError)).toBe(false);

    const kvError = `
      ✘ [ERROR] ApiError: KV namespace not found
      status: 404
    `;
    expect(isContainersForbiddenError(kvError)).toBe(false);
  });
});
