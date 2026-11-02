/**
 * Issue #1778 (Adapter S4, program #1717) — the one BrowserRenderer port.
 *
 * Before S4, `src/services/browserAgent.ts` called the Cloudflare
 * Browser Rendering binding directly (`this.env.BROWSER.fetch(…)`)
 * with no interface. After S4 every render from that site goes
 * through this interface, and the Cloudflare implementation in
 * `cloudflareBrowserRenderer.ts` is the ONLY module that calls
 * `BROWSER.fetch`.
 *
 * This file carries types + the interface ONLY — no provider access.
 * `render` returns null on any render failure (unbound-equivalent,
 * non-OK response, throw, unparseable body) so the caller keeps its
 * existing fail-soft contract: fall through to the HTTP-fetch +
 * DOM-parsing fallback, whose screenshots are labelled placeholders,
 * never presented as page captures. No config switch is needed for
 * this slice: no behavior variant is introduced, only the access
 * path moves, and no caller can configure away an enforcement
 * through this port (rendering, not an IAAA gate).
 */

/** A render request — the pre-S4 call site's request fields. */
export interface BrowserRenderRequest {
  url: string;
  selector?: string;
  waitForTimeoutMs?: number;
  screenshot?: boolean;
}

/** A rendered page, as parsed from the binding's JSON response. */
export interface BrowserRenderResult {
  title?: string;
  text?: string;
  tables?: Array<Array<string>>;
  screenshotBase64?: string;
}

/**
 * The browser-rendering port. `null` means "no render available" —
 * the caller falls back, it never throws for a failed render.
 */
export interface BrowserRenderer {
  render(request: BrowserRenderRequest): Promise<BrowserRenderResult | null>;
}
