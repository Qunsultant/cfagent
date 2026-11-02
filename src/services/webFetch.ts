/**
 * Web fetch service — issue #2760 (tracker #2708 item A3).
 *
 * The mesh registry's web-fetch family was recorded `absent` by
 * S14 (#2417): no standalone web_fetch tool existed; BrowserAgent
 * was the only fetch surface. This module is the deterministic
 * service behind the `web_fetch` MCP command
 * (src/mcps/openaimp/webFetchCommands.ts): fetch ONE URL with a
 * plain Worker fetch and return its readable text.
 *
 * Extraction reuses the repository's existing extractor —
 * `stripHtmlToText` from src/services/browserAgent.ts, the
 * spec-aware HTML stripper (#851–#853) that BrowserAgent's own
 * fetch fallback (ETradeBrowserService.inspectPage) produces its
 * text with — so web_fetch output is consistent with what
 * BrowserAgent produces, not a second implementation. What this
 * service adds over inspectPage is the standalone-tool contract:
 * no Browser Rendering, no screenshots, no tables, no Slack —
 * just the page text, under explicit limits, with named errors.
 *
 * Failure honesty is the contract: non-2xx responses, unsupported
 * content types, invalid or non-http(s) URLs, timeouts, and
 * network failures each throw a WebFetchError with a stable
 * `web_fetch_*` code. Content is never fabricated and an
 * unavailable page never becomes a silent empty success.
 *
 * Reachable-URL posture is parity with the already-shipped
 * `browser_inspect_page`, which fetches caller-supplied URLs
 * server-side today; this service validates http/https only,
 * rejects URLs carrying embedded credentials, and bounds size
 * and time — it does not widen the reachable-URL class.
 */

import { stripHtmlToText } from "./browserAgent";

// ---------------------------------------------------------------------------
// Limits (hard, in code — named here, pinned by test)
// ---------------------------------------------------------------------------

/** Default per-fetch timeout when the caller names none. */
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
/** A caller-requested timeout is clamped to this ceiling. */
export const WEB_FETCH_MAX_TIMEOUT_MS = 30_000;
/** Raw response-body cap; the body read stops here (truncated). */
export const WEB_FETCH_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Extracted-text cap; longer text is cut here (truncated). */
export const WEB_FETCH_MAX_TEXT_CHARS = 20_000;

/**
 * The same User-Agent BrowserAgent's fetch fallback sends
 * (ETradeBrowserService.inspectPage), so sites see one fetcher.
 */
const WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloudflareAgents/1.0";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface WebFetchResult {
  success: true;
  /** The requested URL, normalized. */
  url: string;
  /** The URL after any redirects (the response's own URL). */
  finalUrl: string;
  /** HTTP status of the (final) response. */
  status: number;
  /** The response content type (or the sniffed base type). */
  contentType: string;
  /** The page's <title> for HTML responses; absent otherwise. */
  title?: string;
  /** Readable text: extracted for HTML, raw body for text kinds. */
  text: string;
  /** True when the body read or the text hit a named limit. */
  truncated: boolean;
  fetchedAt: string;
}

export type WebFetchErrorCode =
  | "web_fetch_invalid_url"
  | "web_fetch_unsupported_protocol"
  | "web_fetch_http_error"
  | "web_fetch_unsupported_content_type"
  | "web_fetch_timeout"
  | "web_fetch_network_error";

/**
 * The named failure surface of this service. `code` is stable and
 * machine-checkable; the message is the business error a caller
 * may show (what was fetched + what failed), with no internals.
 */
export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;
  /** The HTTP status, for web_fetch_http_error. */
  readonly status?: number;

  constructor(code: WebFetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface WebFetchOptions {
  /** Per-fetch timeout; clamped to [1, WEB_FETCH_MAX_TIMEOUT_MS]. */
  timeoutMs?: number;
  /** Extracted-text cap; clamped to [1, WEB_FETCH_MAX_TEXT_CHARS]. */
  maxTextChars?: number;
  /** Raw body cap; clamped to [1, WEB_FETCH_MAX_BODY_BYTES]. */
  maxBodyBytes?: number;
  /** Injectable for tests; production calls use the global fetch. */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseFetchUrl(rawUrl: string): URL {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    throw new WebFetchError("web_fetch_invalid_url", "web_fetch requires a non-empty URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebFetchError(
      "web_fetch_invalid_url",
      `web_fetch cannot fetch "${trimmed}": not a valid URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebFetchError(
      "web_fetch_unsupported_protocol",
      `web_fetch only fetches http(s) URLs; "${parsed.protocol}" is not supported.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new WebFetchError(
      "web_fetch_invalid_url",
      "web_fetch does not accept URLs with embedded credentials.",
    );
  }
  return parsed;
}

type BodyKind = "html" | "text";

function kindForContentType(contentType: string): BodyKind | undefined {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "text/html" || base === "application/xhtml+xml") return "html";
  if (base.startsWith("text/") || base === "application/json" || base.endsWith("+json")) {
    return "text";
  }
  return undefined;
}

/**
 * Read a response body under a hard byte cap. Streams so an
 * oversize body is cut at the cap instead of buffered whole;
 * `truncated` reports the cut — never silent.
 */
async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const whole = await res.text();
    return { text: whole.slice(0, cap), truncated: whole.length > cap };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > cap) {
      const room = cap - received;
      if (room > 0) out += decoder.decode(value.subarray(0, room), { stream: true });
      truncated = true;
      received = cap;
      await reader.cancel();
      break;
    }
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return { text: out, truncated };
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/**
 * Fetch one URL and return its readable text. Throws WebFetchError
 * (named code) for every failure mode; a resolved result always
 * carries real fetched content.
 */
export async function fetchWebPage(
  rawUrl: string,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const parsed = parseFetchUrl(rawUrl);
  const url = parsed.toString();
  const timeoutMs = clamp(
    options.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS,
    1,
    WEB_FETCH_MAX_TIMEOUT_MS,
  );
  const maxTextChars = clamp(
    options.maxTextChars ?? WEB_FETCH_MAX_TEXT_CHARS,
    1,
    WEB_FETCH_MAX_TEXT_CHARS,
  );
  const maxBodyBytes = clamp(
    options.maxBodyBytes ?? WEB_FETCH_MAX_BODY_BYTES,
    1,
    WEB_FETCH_MAX_BODY_BYTES,
  );
  const fetchFn = options.fetchFn ?? fetch;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        "User-Agent": WEB_FETCH_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut || (err as Error | undefined)?.name === "AbortError") {
      throw new WebFetchError(
        "web_fetch_timeout",
        `web_fetch timed out after ${timeoutMs}ms fetching ${url}.`,
      );
    }
    throw new WebFetchError(
      "web_fetch_network_error",
      `web_fetch could not fetch ${url}: ${(err as Error)?.message ?? "network failure"}.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new WebFetchError(
      "web_fetch_http_error",
      `web_fetch got HTTP ${res.status} fetching ${url}.`,
      res.status,
    );
  }

  const rawContentType = res.headers.get("content-type") ?? "";
  let kind = kindForContentType(rawContentType);
  if (kind === undefined && rawContentType.trim() !== "") {
    throw new WebFetchError(
      "web_fetch_unsupported_content_type",
      `web_fetch cannot extract text from ${rawContentType.split(";")[0].trim()} (${url}); it reads HTML and text responses.`,
    );
  }

  const { text: bodyText, truncated: bodyTruncated } = await readBodyCapped(res, maxBodyBytes);

  // No content type was declared: sniff the body's first
  // non-whitespace character — markup is extracted as HTML,
  // anything else passes through as text. The sniffed base type
  // is what the result reports.
  let contentType = rawContentType;
  if (kind === undefined) {
    kind = bodyText.trimStart().startsWith("<") ? "html" : "text";
    contentType = kind === "html" ? "text/html" : "text/plain";
  }

  let title: string | undefined;
  let text: string;
  if (kind === "html") {
    const titleMatch = bodyText.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = titleMatch ? titleMatch[1].trim() : undefined;
    text = stripHtmlToText(bodyText);
  } else {
    text = bodyText;
  }

  let truncated = bodyTruncated;
  if (text.length > maxTextChars) {
    text = text.slice(0, maxTextChars);
    truncated = true;
  }

  return {
    success: true,
    url,
    finalUrl: res.url || url,
    status: res.status,
    contentType,
    ...(title ? { title } : {}),
    text,
    truncated,
    fetchedAt: new Date().toISOString(),
  };
}
