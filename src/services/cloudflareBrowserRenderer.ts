/**
 * Issue #1778 (Adapter S4, program #1717) — the Cloudflare BROWSER
 * implementation of the BrowserRenderer port (`browserRendererPorts.ts`).
 *
 * This is the ONLY module in the repo that calls `BROWSER.fetch`.
 * Every other module reaches browser rendering through the
 * `BrowserRenderer` interface; application code must not import this
 * module's binding call, only the port and this factory.
 *
 * The render request is moved verbatim from the pre-S4 call site in
 * `src/services/browserAgent.ts` (`inspectPage`): POST to the
 * Browser Rendering endpoint with url / selector (default `body`) /
 * waitForTimeout (default 3000ms) / screenshot flag, parsed as
 * title / text-or-content / tables / screenshotBase64. The fail-soft
 * contract is preserved exactly: any failure (non-OK response,
 * throw, unparseable body) returns null and the caller falls through
 * to its HTTP-fetch + DOM-parsing fallback.
 */

import type {
  BrowserRenderRequest,
  BrowserRenderResult,
  BrowserRenderer,
} from "./browserRendererPorts";

/** The env half the adapter needs — the BROWSER binding, nothing else. */
export interface BrowserRendererEnv {
  BROWSER?: { fetch: (request: Request) => Promise<Response> };
}

class CloudflareBrowserRenderer implements BrowserRenderer {
  constructor(private readonly binding: { fetch: (request: Request) => Promise<Response> }) {}

  async render(request: BrowserRenderRequest): Promise<BrowserRenderResult | null> {
    try {
      const renderReq = new Request("https://browser.cloudflare.local/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: request.url,
          selector: request.selector || "body",
          waitForTimeout: request.waitForTimeoutMs || 3000,
          screenshot: request.screenshot ?? false,
        }),
      });
      const resp = await this.binding.fetch(renderReq);
      if (!resp.ok) return null;
      const data = (await resp.json()) as {
        title?: string;
        text?: string;
        content?: string;
        tables?: Array<Array<string>>;
        screenshotBase64?: string;
      };
      return {
        title: data.title,
        text: data.text || data.content || "",
        tables: data.tables || [],
        screenshotBase64: data.screenshotBase64,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Build the BrowserRenderer for an env, or null when `BROWSER` is
 * unbound or lacks a `fetch` function. Callers keep their existing
 * unbound contract on null (HTTP-fetch fallback) — the port never
 * invents a renderer when the binding is absent.
 *
 * Note: unlike EMAIL, `BROWSER` IS declared in `wrangler.jsonc`
 * (issue #2253), so a deployed Worker with that declaration serves
 * the real capture path; unbound environments keep the fallback.
 */
export function createBrowserRenderer(
  env: BrowserRendererEnv | undefined | null,
): BrowserRenderer | null {
  const binding = env?.BROWSER;
  if (!binding || typeof binding.fetch !== "function") return null;
  return new CloudflareBrowserRenderer(binding);
}
