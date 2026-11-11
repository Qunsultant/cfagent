/**
 * Issue #1247 (add-provider slice of epic #1116) — Public.com provider pins.
 *
 * Public is NOT a REST integration: the sibling repo OpenAIMP/cfpay
 * proved live against production that Public's data surface is its
 * HOSTED MCP server (POST JSON-RPC to https://mcp.public.com/mcp,
 * Bearer token, MCP protocol 2025-06-18), and that the market-data
 * tools' argument names are NOT published — cfpay reads each tool's
 * live inputSchema via tools/list and maps semantic parameters onto
 * the properties the schema actually declares. These pins follow
 * that pattern exactly: argument names in the fixtures come from the
 * fixture schemas, never from the implementation's imagination.
 *
 * Auth fits cfagent's existing OAuth model (steering 2026-10-23):
 * Public is a RESOURCE provider in the E*TRADE shape — per-provider
 * module src/security/publicOAuth.ts, tokens in the SessionStore DO
 * under public:token:<login>, CSRF state via session.ts
 * createState/verifyState, routes /auth/public/start|callback — and
 * the OAuth2 mechanics it needs (PKCE S256, RFC 8414 discovery, code
 * exchange, refresh) live in the SHARED src/security/oauth2Core.ts.
 * Public is never a login provider: its callback must not create or
 * replace a login session (pinned below).
 *
 * No live network and no credential values: the MCP seam is a stubbed
 * fetch with cfpay-shaped fixtures; every token string is a plainly
 * synthetic non-secret-shaped literal ("test-access-token" etc.).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import {
  PublicMcpClient,
  PublicMcpError,
  PUBLIC_MCP_URL,
  parsePublicRpcBody,
} from "../src/mcps/public/publicMcp";
import {
  schemaProps,
  matchProp,
  pickArgs,
  missingRequired,
  parseToolJson,
  extractExpirations,
  extractAccountId,
  readPublicQuotes,
  readPublicOptionExpirations,
  readPublicOptionChain,
  extractPublicQuoteRows,
  mapPublicQuoteRow,
  PublicDataError,
} from "../src/services/publicData";
import {
  createPkcePair,
  pkceChallengeFor,
  discoverAuthorizationServerFromResource,
  fetchAuthorizationServerMetadata,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  OAuth2Error,
} from "../src/security/oauth2Core";
import {
  DEFAULT_PUBLIC_OAUTH_SCOPES,
  PublicClientRejectedError,
  publicClientId,
  publicClientMetadataDocument,
  publicTokenKey,
  suggestedPublicCredentialRef,
  storePublicTokens,
  getStoredPublicTokens,
  revokeStoredPublicTokens,
  storePublicPersonalToken,
  getPublicOAuthPending,
  startPublicOAuth,
  completePublicOAuth,
  getPublicAccessToken,
  resolvePublicCredentialRef,
  type PublicTokenSet,
} from "../src/security/publicOAuth";
import { verifyState } from "../src/security/session";
import {
  createPublicDataProvider,
  createPublicDataProviderFromEnv,
  verifyPublicDataProvider,
} from "../src/trading/dataProviders/adapters";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import {
  seedProviderConfigs,
  bootstrapDataProviders,
  listProviderConfigs,
  listCapabilityRoutes,
  upsertCapabilityRoute,
  getProviderConfig,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  listCapturesByProvider,
  readCaptureRaw,
} from "../src/trading/dataProviders/captureStore";
import { getVerificationEvidence } from "../src/trading/dataProviders/lifecycle";
import {
  handleDataProviderRoutes,
  buildDataProviderVerifier,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import type { Env } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures — cfpay-shaped MCP seam
// ---------------------------------------------------------------------------

const LOGIN = "octocat";
const ORIGIN = "https://agent.example.test";
const AS_ISSUER = "https://as.public.test/userapiauthservice/oauth2";
const AS_METADATA_URL = `${AS_ISSUER}/.well-known/oauth-authorization-server`;
const PRM_URL = "https://mcp.public.com/.well-known/oauth-protected-resource";
const TOKEN_ENDPOINT = `${AS_ISSUER}/token`;
const AUTHORIZE_ENDPOINT = `${AS_ISSUER}/authorize`;

const PERSONAL_TOKEN = "test-personal-token";
const ACCESS_TOKEN = "test-access-token";
const REFRESH_TOKEN = "test-refresh-token";
const NEW_ACCESS_TOKEN = "test-access-token-refreshed";

/** Tool schemas as the (fixture) MCP server declares them via tools/list. */
const FIXTURE_TOOLS = [
  {
    name: "get_accounts",
    description: "List brokerage accounts",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_quotes",
    description: "Batch quotes",
    inputSchema: {
      type: "object",
      properties: { symbols: { type: "array" }, account_id: { type: "string" } },
      required: ["symbols"],
    },
  },
  {
    name: "get_option_expirations",
    description: "Option expiration dates for an underlying",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, account_id: { type: "string" } },
      required: ["symbol", "account_id"],
    },
  },
  {
    name: "get_option_chain",
    description: "Option chain for one expiration",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        expiration_date: { type: "string" },
        account_id: { type: "string" },
      },
      required: ["symbol", "expiration_date", "account_id"],
    },
  },
];

const QUOTES_PAYLOAD = {
  quotes: [
    {
      instrument: { symbol: "AAPL", type: "EQUITY" },
      last: 232.5,
      bid: 232.4,
      ask: 232.6,
      volume: 123456,
      previous_close: 230.0,
      one_day_change: { change: 2.5, percent_change: 1.087 },
      timestamp: "2026-10-23T15:59:00Z",
    },
    {
      instrument: { symbol: "MSFT", type: "EQUITY" },
      last: 510.25,
      bid: 510.1,
      ask: 510.4,
      volume: 98765,
      previous_close: 512.0,
      one_day_change: { change: -1.75, percent_change: -0.342 },
      timestamp: "2026-10-23T15:59:00Z",
    },
  ],
};

const EXPIRATIONS_PAYLOAD = { expirations: ["2026-01-16", "2026-02-20"] };

const ACCOUNTS_PAYLOAD = [{ account_id: "acct-1", type: "BROKERAGE" }];

const CHAIN_PAYLOAD = {
  symbol: "AAPL",
  underlying_price: 232.5,
  calls: [
    {
      symbol: "AAPL260116C00230000",
      strike_price: 230,
      bid: 4.1,
      ask: 4.3,
      last: 4.2,
      volume: 100,
      open_interest: 2500,
      option_details: {
        greeks: { delta: 0.55, gamma: 0.02, theta: -0.05, vega: 0.12, implied_volatility: 0.24 },
      },
    },
    {
      symbol: "AAPL260116C00235000",
      strike_price: 235,
      bid: 2.0,
      ask: 2.2,
      last: 2.1,
    },
  ],
  puts: [
    {
      symbol: "AAPL260116P00230000",
      strike_price: 230,
      bid: 3.0,
      ask: 3.2,
      last: 3.1,
      option_details: { greeks: { delta: -0.44, implied_volatility: 0.25 } },
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  jsonBody?: any;
  textBody?: string;
}

/**
 * The stubbed network: MCP JSON-RPC + OAuth discovery/token endpoints
 * + the authorize-endpoint probe, routed by URL. `tools` and the
 * per-tool text results are overridable per test.
 */
function makeFakeNetwork(overrides: {
  tools?: unknown[];
  toolText?: Record<string, string | ((args: any) => string)>;
  tokenResponse?: Record<string, unknown>;
  authorizeProbe?: "redirect" | "client-rejected";
  sseToolsCall?: boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  const tools = overrides.tools ?? FIXTURE_TOOLS;
  const toolText: Record<string, string | ((args: any) => string)> = {
    get_accounts: JSON.stringify(ACCOUNTS_PAYLOAD),
    get_quotes: JSON.stringify(QUOTES_PAYLOAD),
    get_option_expirations: JSON.stringify(EXPIRATIONS_PAYLOAD),
    get_option_chain: JSON.stringify(CHAIN_PAYLOAD),
    ...(overrides.toolText ?? {}),
  };
  const fetchImpl = async (input: any, init: any = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method ?? (typeof input !== "string" ? input.method : undefined) ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init.headers ?? (typeof input !== "string" ? Object.fromEntries(input.headers.entries()) : {});
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    let jsonBody: any;
    try {
      jsonBody = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      jsonBody = undefined;
    }
    calls.push({ url, method, headers, jsonBody, textBody: bodyText });

    // OAuth: authorization-server metadata + protected-resource metadata.
    if (url === AS_METADATA_URL) {
      return Response.json({
        issuer: AS_ISSUER,
        authorization_endpoint: AUTHORIZE_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
        revocation_endpoint: `${AS_ISSUER}/revoke`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["openid", "offline_access", "marketdata", "trading.read"],
      });
    }
    if (url === PRM_URL) {
      return Response.json({ resource: PUBLIC_MCP_URL, authorization_servers: [AS_ISSUER] });
    }
    // OAuth: authorize-endpoint probe (the connect flow checks whether
    // Public rejects this client_id before redirecting the browser).
    if (url.startsWith(AUTHORIZE_ENDPOINT)) {
      if (overrides.authorizeProbe === "client-rejected") {
        return new Response(JSON.stringify({ error: "invalid_request", error_description: "client_id is not registered" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 302, headers: { Location: "https://public.com/login" } });
    }
    // OAuth: token endpoint (code exchange + refresh grant).
    if (url === TOKEN_ENDPOINT) {
      const form = new URLSearchParams(bodyText ?? "");
      const grant = form.get("grant_type");
      const base = overrides.tokenResponse ?? {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        token_type: "Bearer",
      };
      if (grant === "refresh_token" && form.get("refresh_token") !== REFRESH_TOKEN) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json(base);
    }
    // MCP endpoint.
    if (url === PUBLIC_MCP_URL) {
      const auth = headers["authorization"] ?? "";
      if (!auth.startsWith("Bearer ") || auth === "Bearer bad-token") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${PRM_URL}"`,
          },
        });
      }
      const rpc = jsonBody ?? {};
      if (rpc.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" },
        });
      }
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name as string;
        const spec = toolText[name];
        const text = typeof spec === "function" ? spec(rpc.params?.arguments ?? {}) : spec ?? "";
        const result = { content: [{ type: "text", text }] };
        if (overrides.sseToolsCall) {
          return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    }
    throw new Error(`fake network: unexpected URL ${url}`);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** In-memory SessionStore DO namespace speaking the store protocol (etrade_oauth.test.ts idiom), recording every op. */
function makeFakeSessionStore() {
  const data = new Map<string, string>();
  const ops: Array<{ ns: string; op: string; key: string }> = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as { op: string; ns: string; key: string; value?: string; ttl?: number };
        ops.push({ ns: body.ns, op: body.op, key: body.key });
        const full = `${body.ns}::${body.key}`;
        if (body.op === "get") return Response.json({ value: data.get(full) ?? null });
        if (body.op === "put") {
          data.set(full, body.value ?? "");
          return Response.json({ ok: true });
        }
        if (body.op === "delete") {
          data.delete(full);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unknown op" }, { status: 400 });
      },
    }),
  };
  return { namespace, data, ops };
}

function makeEnv(store: ReturnType<typeof makeFakeSessionStore>, extra: Record<string, unknown> = {}): Env {
  return {
    SESSION_STORE: store.namespace as any,
    SESSION_SECRET: "test-session-secret",
    APP_BASE_URL: ORIGIN,
    ...extra,
  } as unknown as Env;
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function staticClient(token: string | null, net: ReturnType<typeof makeFakeNetwork>): PublicMcpClient {
  return new PublicMcpClient({
    accessTokenProvider: async () => token,
    fetchImpl: net.fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// MCP transport (cfpay public-mcp semantics)
// ---------------------------------------------------------------------------

describe("public MCP transport", () => {
  it("sends the proven wire shape: POST JSON-RPC, Bearer, protocol version, session threading", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_quotes");
    const first = net.calls.find((c) => c.url === PUBLIC_MCP_URL)!;
    expect(first.method).toBe("POST");
    expect(first.headers["content-type"]).toBe("application/json");
    expect(first.headers["accept"]).toBe("application/json, text/event-stream");
    expect(first.headers["authorization"]).toBe(`Bearer ${PERSONAL_TOKEN}`);
    expect(first.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(first.jsonBody).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
    // The server issued Mcp-Session-Id "sess-1" on the first response;
    // the next call must echo it.
    await client.callToolText("get_quotes", { symbols: ["AAPL"] });
    const second = net.calls.filter((c) => c.url === PUBLIC_MCP_URL)[1];
    expect(second.headers["mcp-session-id"]).toBe("sess-1");
    expect(second.jsonBody).toMatchObject({
      method: "tools/call",
      params: { name: "get_quotes", arguments: { symbols: ["AAPL"] } },
    });
  });

  it("parses an SSE-framed response (first JSON data frame)", async () => {
    const net = makeFakeNetwork({ sseToolsCall: true });
    const client = staticClient(PERSONAL_TOKEN, net);
    const text = await client.callToolText("get_quotes", { symbols: ["AAPL"] });
    expect(JSON.parse(text)).toEqual(QUOTES_PAYLOAD);
  });

  it("parsePublicRpcBody: plain JSON, SSE frame, and an honest throw on garbage", () => {
    expect(parsePublicRpcBody('{"a":1}')).toEqual({ a: 1 });
    expect(parsePublicRpcBody('event: message\ndata: {"b":2}\n\n')).toEqual({ b: 2 });
    expect(() => parsePublicRpcBody("not json at all")).toThrow(/unparseable/);
  });

  it("a 401 is a typed error naming the rejected token", async () => {
    const net = makeFakeNetwork();
    const client = staticClient("bad-token", net);
    const err = await client.listTools().catch((e) => e);
    expect(err).toBeInstanceOf(PublicMcpError);
    expect((err as PublicMcpError).status).toBe(401);
    expect((err as Error).message).toMatch(/access token was rejected/);
  });

  it("a JSON-RPC error object surfaces as a typed error", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    await expect(client.callRpc("tools/nope", {})).rejects.toThrow(/method not found/);
  });

  it("no credential ⇒ typed refusal BEFORE any network call", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(null, net);
    await expect(client.listTools()).rejects.toThrow(PublicMcpError);
    expect(net.calls).toHaveLength(0);
  });

  it("read-only by construction: a non-allow-listed tool is refused before any network call", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    await expect(client.callToolText("place_order", {})).rejects.toThrow(/allow-list/);
    await expect(client.callToolText("get_portfolio", {})).rejects.toThrow(/allow-list/);
    expect(net.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema mapping (cfpay public-data semantics: names come from the schema)
// ---------------------------------------------------------------------------

describe("public schema mapping", () => {
  it("schemaProps / matchProp / pickArgs / missingRequired follow the declared schema", () => {
    const schema = {
      type: "object",
      properties: { Symbol: { type: "string" }, expiration_date: { type: "string" } },
      required: ["Symbol", "expiration_date", "account_id"],
    };
    expect(schemaProps(schema).required).toEqual(["Symbol", "expiration_date", "account_id"]);
    // Case-insensitive match finds the declared "Symbol".
    expect(matchProp(schemaProps(schema).properties, ["symbol", "ticker"])).toBe("Symbol");
    const picked = pickArgs(schema, {
      symbol: { names: ["symbol", "ticker"], value: "AAPL" },
      expiration: { names: ["expiration", "expiration_date"], value: "2026-01-16" },
    });
    expect(picked.args).toEqual({ Symbol: "AAPL", expiration_date: "2026-01-16" });
    expect(picked.matched.symbol).toBe("Symbol");
    // account_id is required by the schema but nothing mapped onto it:
    // reported by name, never guessed.
    expect(missingRequired(schema, picked.args)).toEqual(["account_id"]);
    expect(schemaProps(null)).toEqual({ properties: {}, required: [] });
  });

  it("parseToolJson unwraps one level of double-encoding", () => {
    expect(parseToolJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolJson(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(parseToolJson("plain text, not json")).toBeUndefined();
  });

  it("extractExpirations reads string arrays, date-field objects, and wrappers", () => {
    expect(extractExpirations(["2026-01-16", "2026-02-20"])).toEqual(["2026-01-16", "2026-02-20"]);
    expect(extractExpirations({ expirations: [{ expirationDate: "2026-01-16" }] })).toEqual(["2026-01-16"]);
    expect(extractExpirations({ data: { dates: ["Fri, Jan 16 2026 (2026-01-16)"] } })).toEqual([]);
    expect(extractExpirations(null)).toEqual([]);
  });

  it("extractAccountId finds the first account id across result shapes", () => {
    expect(extractAccountId([{ account_id: "acct-1" }])).toBe("acct-1");
    expect(extractAccountId({ accounts: [{ accountId: "acct-2" }] })).toBe("acct-2");
    expect(extractAccountId({ accountId: "acct-3" })).toBe("acct-3");
    expect(extractAccountId([{ type: "BROKERAGE" }])).toBeUndefined();
    expect(extractAccountId(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Data reads + contract mapping
// ---------------------------------------------------------------------------

describe("public data reads and mapping", () => {
  it("quotes: batch arg name comes from the schema; rows map with absent fields staying absent", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicQuotes(client, ["AAPL", "MSFT"]);
    expect(read.tool).toBe("get_quotes");
    expect(read.args).toEqual({ symbols: ["AAPL", "MSFT"] });
    const rows = extractPublicQuoteRows(read.payload);
    expect(rows).toHaveLength(2);
    const aapl = mapPublicQuoteRow(rows[0], "2026-10-23T16:00:00Z")!;
    expect(aapl.symbol).toBe("AAPL");
    expect(aapl.lastPrice).toBe(232.5);
    expect(aapl.bid).toBe(232.4);
    expect(aapl.ask).toBe(232.6);
    expect(aapl.volume).toBe(123456);
    expect(aapl.previousClose).toBe(230.0);
    expect(aapl.change).toBe(2.5);
    expect(aapl.changePercent).toBe(1.087);
    expect(aapl.timestamp).toBe("2026-10-23T15:59:00Z");
    // The payload carries no open/high/low/companyName: the mapped
    // quote must NOT invent them (no zero-fill, no symbol-as-name).
    expect("open" in aapl).toBe(false);
    expect("high" in aapl).toBe(false);
    expect("companyName" in aapl).toBe(false);
  });

  it("quotes: a schema declaring 'tickers' instead of 'symbols' is honoured", async () => {
    const tools = FIXTURE_TOOLS.map((t) =>
      t.name === "get_quotes"
        ? { ...t, inputSchema: { type: "object", properties: { tickers: { type: "array" } }, required: ["tickers"] } }
        : t
    );
    const net = makeFakeNetwork({ tools });
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicQuotes(client, ["AAPL"]);
    expect(read.args).toEqual({ tickers: ["AAPL"] });
  });

  it("quotes: a per-symbol schema falls back to one call per symbol", async () => {
    const tools = FIXTURE_TOOLS.map((t) =>
      t.name === "get_quotes"
        ? { ...t, inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } }
        : t
    );
    const net = makeFakeNetwork({
      tools,
      toolText: {
        get_quotes: (args: any) =>
          JSON.stringify({ quotes: QUOTES_PAYLOAD.quotes.filter((q) => q.instrument.symbol === args.symbol) }),
      },
    });
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicQuotes(client, ["AAPL", "MSFT"]);
    expect(extractPublicQuoteRows(read.payload)).toHaveLength(2);
    const quoteCalls = net.calls.filter((c) => c.jsonBody?.method === "tools/call" && c.jsonBody?.params?.name === "get_quotes");
    expect(quoteCalls).toHaveLength(2);
  });

  it("expirations: the account id the schema requires is resolved via get_accounts and mapped on", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicOptionExpirations(client, "AAPL");
    expect(read.expirations).toEqual(["2026-01-16", "2026-02-20"]);
    const expCall = net.calls.find(
      (c) => c.jsonBody?.method === "tools/call" && c.jsonBody?.params?.name === "get_option_expirations"
    )!;
    expect(expCall.jsonBody.params.arguments).toEqual({ symbol: "AAPL", account_id: "acct-1" });
  });

  it("expirations: a required account id that cannot be read is reported by name, and the tool is never called", async () => {
    const net = makeFakeNetwork({ toolText: { get_accounts: JSON.stringify([{ type: "BROKERAGE" }]) } });
    const client = staticClient(PERSONAL_TOKEN, net);
    await expect(readPublicOptionExpirations(client, "AAPL")).rejects.toThrow(/account_id/);
    const expCalls = net.calls.filter((c) => c.jsonBody?.params?.name === "get_option_expirations");
    expect(expCalls).toHaveLength(0);
  });

  it("chain: calls/puts pair by strike, Greeks map only where the payload carries them", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicOptionChain(client, "AAPL", "2026-01-16");
    const chain = read.chain!;
    expect(chain.symbol).toBe("AAPL");
    expect(chain.underlyingPrice).toBe(232.5);
    expect(chain.selectedExpiry).toEqual({ year: 2026, month: 1, day: 16 });
    expect(chain.pairs).toHaveLength(2);
    const [first, second] = chain.pairs;
    expect(first.call?.strikePrice).toBe(230);
    expect(first.call?.optionType).toBe("CALL");
    expect(first.call?.delta).toBe(0.55);
    expect(first.call?.gamma).toBe(0.02);
    expect(first.call?.theta).toBe(-0.05);
    expect(first.call?.vega).toBe(0.12);
    expect(first.call?.impliedVolatility).toBe(0.24);
    expect(first.call?.openInterest).toBe(2500);
    expect(first.put?.strikePrice).toBe(230);
    expect(first.put?.delta).toBe(-0.44);
    // The 235 call carries no greeks in the payload: no greek keys.
    expect(second.call?.strikePrice).toBe(235);
    expect(second.put).toBeUndefined();
    expect("delta" in (second.call as object)).toBe(false);
    const chainCall = net.calls.find(
      (c) => c.jsonBody?.method === "tools/call" && c.jsonBody?.params?.name === "get_option_chain"
    )!;
    expect(chainCall.jsonBody.params.arguments).toEqual({
      symbol: "AAPL",
      expiration_date: "2026-01-16",
      account_id: "acct-1",
    });
  });

  it("chain: no expiry given resolves the nearest listed expiration first", async () => {
    const net = makeFakeNetwork();
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicOptionChain(client, "AAPL", null);
    expect(read.chain?.selectedExpiry).toEqual({ year: 2026, month: 1, day: 16 });
    const names = net.calls
      .filter((c) => c.jsonBody?.method === "tools/call")
      .map((c) => c.jsonBody.params.name);
    expect(names.indexOf("get_option_expirations")).toBeLessThan(names.indexOf("get_option_chain"));
  });

  it("chain: a double-encoded tool result still maps", async () => {
    const net = makeFakeNetwork({
      toolText: { get_option_chain: JSON.stringify(JSON.stringify(CHAIN_PAYLOAD)) },
    });
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicOptionChain(client, "AAPL", "2026-01-16");
    expect(read.chain?.pairs).toHaveLength(2);
  });

  it("chain: a payload with no parseable contracts is a null chain (conformant), not an invention", async () => {
    const net = makeFakeNetwork({ toolText: { get_option_chain: JSON.stringify({ symbol: "AAPL", calls: [], puts: [] }) } });
    const client = staticClient(PERSONAL_TOKEN, net);
    const read = await readPublicOptionChain(client, "AAPL", "2026-01-16");
    expect(read.chain).toBeNull();
  });

  it("reads refuse when the account does not offer the tool", async () => {
    const net = makeFakeNetwork({ tools: FIXTURE_TOOLS.filter((t) => t.name !== "get_quotes") });
    const client = staticClient(PERSONAL_TOKEN, net);
    await expect(readPublicQuotes(client, ["AAPL"])).rejects.toThrow(/did not offer get_quotes/);
  });
});

// ---------------------------------------------------------------------------
// Shared OAuth2 core (src/security/oauth2Core.ts)
// ---------------------------------------------------------------------------

describe("oauth2 core", () => {
  it("PKCE: the challenge is the S256 (base64url SHA-256) of the verifier", async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(32);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pair.verifier));
    const expected = Buffer.from(new Uint8Array(digest))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(pair.challenge).toBe(expected);
    expect(await pkceChallengeFor(pair.verifier)).toBe(expected);
    const other = await createPkcePair();
    expect(other.verifier).not.toBe(pair.verifier);
  });

  it("discovery: 401 challenge → resource metadata → AS metadata (RFC 8414), S256 required", async () => {
    const net = makeFakeNetwork();
    const as = await discoverAuthorizationServerFromResource(PUBLIC_MCP_URL, net.fetchImpl);
    expect(as.issuer).toBe(AS_ISSUER);
    expect(as.authorization_endpoint).toBe(AUTHORIZE_ENDPOINT);
    expect(as.token_endpoint).toBe(TOKEN_ENDPOINT);
    // The bare POST elicited the challenge (no credential presented).
    const probe = net.calls.find((c) => c.url === PUBLIC_MCP_URL)!;
    expect(probe.headers["authorization"]).toBeUndefined();
  });

  it("discovery refuses an AS that does not support PKCE S256", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("oauth-authorization-server")) {
        return Response.json({
          issuer: AS_ISSUER,
          authorization_endpoint: AUTHORIZE_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          code_challenge_methods_supported: ["plain"],
        });
      }
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    await expect(fetchAuthorizationServerMetadata(AS_ISSUER, fetchImpl)).rejects.toThrow(/S256/);
  });

  it("buildAuthorizationUrl carries the full OAuth 2.1 + resource-indicator parameter set", async () => {
    const pair = await createPkcePair();
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: AUTHORIZE_ENDPOINT,
        clientId: publicClientId(ORIGIN),
        redirectUri: `${ORIGIN}/auth/public/callback`,
        state: "state-123",
        codeChallenge: pair.challenge,
        scopes: DEFAULT_PUBLIC_OAUTH_SCOPES,
        resource: PUBLIC_MCP_URL,
      })
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(publicClientId(ORIGIN));
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/public/callback`);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe(pair.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(DEFAULT_PUBLIC_OAUTH_SCOPES);
    expect(url.searchParams.get("resource")).toBe(PUBLIC_MCP_URL);
  });

  it("code exchange posts the PKCE grant form and parses the token set", async () => {
    const net = makeFakeNetwork();
    const tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: TOKEN_ENDPOINT,
        code: "auth-code-1",
        redirectUri: `${ORIGIN}/auth/public/callback`,
        clientId: publicClientId(ORIGIN),
        codeVerifier: "verifier-1",
      },
      net.fetchImpl
    );
    expect(tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    const call = net.calls.find((c) => c.url === TOKEN_ENDPOINT)!;
    const form = new URLSearchParams(call.textBody ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-1");
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/auth/public/callback`);
    expect(form.get("client_id")).toBe(publicClientId(ORIGIN));
    expect(form.get("code_verifier")).toBe("verifier-1");
    // Public client: no client_secret anywhere (token_endpoint_auth_method "none").
    expect(form.get("client_secret")).toBeNull();
  });

  it("refresh grant keeps the stored refresh token when the response omits one", async () => {
    const net = makeFakeNetwork({ tokenResponse: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 } });
    const tokens = await refreshAccessToken(
      { tokenEndpoint: TOKEN_ENDPOINT, refreshToken: REFRESH_TOKEN, clientId: publicClientId(ORIGIN) },
      net.fetchImpl
    );
    expect(tokens.accessToken).toBe(NEW_ACCESS_TOKEN);
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    const call = net.calls.find((c) => c.url === TOKEN_ENDPOINT)!;
    const form = new URLSearchParams(call.textBody ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
  });

  it("a token-endpoint error surfaces as OAuth2Error with the provider's description", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: "invalid_grant", error_description: "code expired" }, { status: 400 })) as unknown as typeof fetch;
    const err = await exchangeAuthorizationCode(
      { tokenEndpoint: TOKEN_ENDPOINT, code: "x", redirectUri: "https://a/b", clientId: "c", codeVerifier: "v" },
      fetchImpl
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OAuth2Error);
    expect((err as Error).message).toMatch(/code expired/);
  });
});

// ---------------------------------------------------------------------------
// Public provider module (src/security/publicOAuth.ts) — etradeOAuth idiom
// ---------------------------------------------------------------------------

describe("public token store", () => {
  it("token-set round-trip under public:token:<login> in the public namespace, then revoke", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const set: PublicTokenSet = {
      kind: "oauth",
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3600_000,
      clientId: publicClientId(ORIGIN),
      issuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      storedAt: new Date().toISOString(),
      userLogin: LOGIN,
    };
    await storePublicTokens(env, set);
    expect(publicTokenKey(LOGIN)).toBe(`public:token:${LOGIN}`);
    const read = await getStoredPublicTokens(env, LOGIN);
    expect(read?.accessToken).toBe(ACCESS_TOKEN);
    expect(read?.refreshToken).toBe(REFRESH_TOKEN);
    expect(read?.kind).toBe("oauth");
    // Stored in the SessionStore DO under the "public" namespace.
    expect(store.data.has(`public::public:token:${LOGIN}`)).toBe(true);
    await revokeStoredPublicTokens(env, LOGIN);
    expect(await getStoredPublicTokens(env, LOGIN)).toBeNull();
  });

  it("a pasted personal token stores through the SAME record, marked kind=personal", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicPersonalToken(env, LOGIN, PERSONAL_TOKEN);
    const read = await getStoredPublicTokens(env, LOGIN);
    expect(read?.kind).toBe("personal");
    expect(read?.accessToken).toBe(PERSONAL_TOKEN);
    // One token source for the adapter: the personal token is what it gets.
    expect(await getPublicAccessToken(env, LOGIN)).toBe(PERSONAL_TOKEN);
  });

  it("the suggested lifecycle credential reference names the canonical store key", () => {
    expect(suggestedPublicCredentialRef(LOGIN)).toBe(`sessionstore:public:public:token:${LOGIN}`);
  });
});

describe("public token source (adapter-facing)", () => {
  it("unexpired OAuth token is returned as stored; no token ⇒ null", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    expect(await getPublicAccessToken(env, LOGIN)).toBeNull();
    await storePublicTokens(env, {
      kind: "oauth",
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3600_000,
      clientId: publicClientId(ORIGIN),
      issuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      storedAt: new Date().toISOString(),
      userLogin: LOGIN,
    });
    const net = makeFakeNetwork();
    expect(await getPublicAccessToken(env, LOGIN, net.fetchImpl)).toBe(ACCESS_TOKEN);
    expect(net.calls.filter((c) => c.url === TOKEN_ENDPOINT)).toHaveLength(0);
  });

  it("an expired OAuth token is refreshed via the token endpoint and the new set persisted", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicTokens(env, {
      kind: "oauth",
      accessToken: "test-access-token-stale",
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() - 1000,
      clientId: publicClientId(ORIGIN),
      issuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      storedAt: new Date().toISOString(),
      userLogin: LOGIN,
    });
    const net = makeFakeNetwork({ tokenResponse: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 } });
    expect(await getPublicAccessToken(env, LOGIN, net.fetchImpl)).toBe(NEW_ACCESS_TOKEN);
    const persisted = await getStoredPublicTokens(env, LOGIN);
    expect(persisted?.accessToken).toBe(NEW_ACCESS_TOKEN);
    // Refresh response omitted a refresh token: the stored one is kept.
    expect(persisted?.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("an expired OAuth token with no refresh token yields null (reconnect is the remedy)", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicTokens(env, {
      kind: "oauth",
      accessToken: "test-access-token-stale",
      expiresAt: Date.now() - 1000,
      storedAt: new Date().toISOString(),
      userLogin: LOGIN,
    });
    expect(await getPublicAccessToken(env, LOGIN)).toBeNull();
  });
});

describe("public OAuth connect flow", () => {
  it("start: discovery + session.ts state + PKCE pending stored under the state", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const net = makeFakeNetwork();
    const { authorizeUrl } = await startPublicOAuth(env, LOGIN, ORIGIN, net.fetchImpl);
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(publicClientId(ORIGIN));
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/public/callback`);
    expect(url.searchParams.get("scope")).toBe(DEFAULT_PUBLIC_OAUTH_SCOPES);
    expect(url.searchParams.get("resource")).toBe(PUBLIC_MCP_URL);
    const state = url.searchParams.get("state")!;
    // The state is a session.ts state: it verifies against the env secret.
    expect(await verifyState(env, state)).toBe(true);
    // The pending record binds that state to this login and the PKCE verifier.
    const pending = await getPublicOAuthPending(env, state);
    expect(pending?.userLogin).toBe(LOGIN);
    expect(pending?.tokenEndpoint).toBe(TOKEN_ENDPOINT);
    expect(url.searchParams.get("code_challenge")).toBe(await pkceChallengeFor(pending!.codeVerifier));
  });

  it("start: when Public rejects the client_id, the flow fails with the honest explanation (cfpay production finding)", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const net = makeFakeNetwork({ authorizeProbe: "client-rejected" });
    const err = await startPublicOAuth(env, LOGIN, ORIGIN, net.fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(PublicClientRejectedError);
    expect((err as Error).message).toMatch(/personal access token/);
  });

  it("callback: a bad state is refused BEFORE any exchange, and nothing is stored", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const net = makeFakeNetwork();
    await expect(completePublicOAuth(env, "forged.state.value", "auth-code-1", LOGIN, net.fetchImpl)).rejects.toThrow(
      /state/
    );
    expect(net.calls.filter((c) => c.url === TOKEN_ENDPOINT)).toHaveLength(0);
    expect(await getStoredPublicTokens(env, LOGIN)).toBeNull();
  });

  it("callback: happy path exchanges, verifies via tools/list, stores the token set — and creates NO login session", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const net = makeFakeNetwork();
    const { authorizeUrl } = await startPublicOAuth(env, LOGIN, ORIGIN, net.fetchImpl);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const result = await completePublicOAuth(env, state, "auth-code-1", LOGIN, net.fetchImpl);
    expect(result.userLogin).toBe(LOGIN);
    expect(result.toolCount).toBe(FIXTURE_TOOLS.length);
    const stored = await getStoredPublicTokens(env, LOGIN);
    expect(stored?.kind).toBe("oauth");
    expect(stored?.accessToken).toBe(ACCESS_TOKEN);
    expect(stored?.refreshToken).toBe(REFRESH_TOKEN);
    // The pending record is single-use: consumed by the callback.
    expect(await getPublicOAuthPending(env, state)).toBeNull();
    await expect(completePublicOAuth(env, state, "auth-code-1", LOGIN, net.fetchImpl)).rejects.toThrow();
    // RESOURCE provider, not a login provider: no write ever touched
    // the login-session namespace, and the identity is the PRE-EXISTING
    // session's login (the pending's), never one Public chose.
    expect(store.ops.some((o) => o.ns === "sessions")).toBe(false);
    expect(result.userLogin).toBe(LOGIN);
  });

  it("callback: a session login that does not match the pending's login is refused", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const net = makeFakeNetwork();
    const { authorizeUrl } = await startPublicOAuth(env, LOGIN, ORIGIN, net.fetchImpl);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await expect(completePublicOAuth(env, state, "auth-code-1", "mallory", net.fetchImpl)).rejects.toThrow(/login/);
    expect(await getStoredPublicTokens(env, LOGIN)).toBeNull();
    expect(await getStoredPublicTokens(env, "mallory")).toBeNull();
  });

  it("the provider module never imports the login-session machinery (source pin)", () => {
    const src = readFileSync("src/security/publicOAuth.ts", "utf8");
    expect(src).not.toMatch(/createSession\s*\(|completeWiredLogin|from\s+["'][^"']*iaaaLogin/);
    // It DOES use the shared state primitives and the shared OAuth2 core.
    expect(src).toMatch(/createState/);
    expect(src).toMatch(/oauth2Core/);
  });

  it("metadata document: client_id is the document URL; contents follow the proven shape", () => {
    expect(publicClientId(ORIGIN)).toBe(`${ORIGIN}/.well-known/oauth-client-id-metadata-document`);
    const doc = publicClientMetadataDocument(ORIGIN);
    expect(doc.iss).toBe(publicClientId(ORIGIN));
    expect(doc.redirect_uris).toEqual([`${ORIGIN}/auth/public/callback`]);
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.response_types).toEqual(["code"]);
    expect(doc.scope).toBe(DEFAULT_PUBLIC_OAUTH_SCOPES);
  });
});

describe("public credential-reference resolution (lifecycle verifier seam)", () => {
  it("no reference ⇒ honest failure naming the missing reference and the suggested default", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const res = await resolvePublicCredentialRef(env, LOGIN, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/no credential reference/);
      expect(res.error).toContain(suggestedPublicCredentialRef(LOGIN));
    }
  });

  it("sessionstore reference to the canonical key resolves the stored token", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicPersonalToken(env, LOGIN, PERSONAL_TOKEN);
    const res = await resolvePublicCredentialRef(env, LOGIN, suggestedPublicCredentialRef(LOGIN));
    expect(res).toEqual({ ok: true, accessToken: PERSONAL_TOKEN });
  });

  it("sessionstore reference to an empty key fails honestly", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const res = await resolvePublicCredentialRef(env, LOGIN, suggestedPublicCredentialRef(LOGIN));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no Public token/);
  });

  it("env reference resolves the named env var as a personal token", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store, { PUBLIC_PERSONAL_TOKEN: PERSONAL_TOKEN });
    const res = await resolvePublicCredentialRef(env, LOGIN, "env:PUBLIC_PERSONAL_TOKEN");
    expect(res).toEqual({ ok: true, accessToken: PERSONAL_TOKEN });
  });
});

// ---------------------------------------------------------------------------
// Adapter: provenance, capture, conformance
// ---------------------------------------------------------------------------

describe("public adapter", () => {
  it("declares exactly the grounded capabilities and tags provenance on every result", async () => {
    const net = makeFakeNetwork();
    const provider = createPublicDataProvider(staticClient(PERSONAL_TOKEN, net));
    expect(provider.id).toBe("public");
    expect(provider.capabilities).toEqual(["quotes", "optionsChains"]);
    const quote = await provider.getQuote!("AAPL");
    expect(quote.providerId).toBe("public");
    expect(quote.capability).toBe("quotes");
    expect((quote.result as any).symbol).toBe("AAPL");
    expect((quote.result as any).lastPrice).toBe(232.5);
    const expiries = await provider.getOptionExpiryDates!("AAPL");
    expect(expiries.result).toEqual([
      { year: 2026, month: 1, day: 16 },
      { year: 2026, month: 2, day: 20 },
    ]);
    const chain = await provider.getOptionsChain!({ symbol: "AAPL", expiryYear: 2026, expiryMonth: 1, expiryDay: 16 });
    expect(chain.capability).toBe("optionsChains");
    expect((chain.result as any).pairs).toHaveLength(2);
  });

  it("captures the tool-call wire payload via the E1 mechanism (provider 'public')", async () => {
    const net = makeFakeNetwork();
    const sql = new MockSqlStorage() as any;
    const storage = fakeBlobStorage();
    const provider = createPublicDataProvider(staticClient(PERSONAL_TOKEN, net), {
      capture: { sql, blobStorage: storage as any, env: {} },
    });
    await provider.getQuote!("AAPL", { runId: "run-pub-1", tenantId: "default", userLogin: LOGIN });
    await provider.getOptionsChain!(
      { symbol: "AAPL", expiryYear: 2026, expiryMonth: 1, expiryDay: 16 },
      { runId: "run-pub-1", tenantId: "default", userLogin: LOGIN }
    );
    const records = listCapturesByProvider(sql, "default", "public");
    expect(records).toHaveLength(2);
    const decodeRaw = async (id: string) => {
      const out = await readCaptureRaw(sql, { storage: storage as any, env: {} }, "default", id);
      expect(out).not.toBeNull();
      expect(out!.rawBytes).not.toBeNull();
      return JSON.parse(new TextDecoder().decode(out!.rawBytes!));
    };
    const quoteRec = records.find((r) => r.capability === "quotes")!;
    expect(quoteRec.status).toBe("captured");
    expect(quoteRec.rawKind).toBe("provider-response");
    expect(await decodeRaw(quoteRec.id)).toEqual(QUOTES_PAYLOAD);
    const chainRec = records.find((r) => r.capability === "optionsChains")!;
    expect(await decodeRaw(chainRec.id)).toEqual(CHAIN_PAYLOAD);
  });

  it("passes the conformance kit for its declared capabilities", async () => {
    const net = makeFakeNetwork();
    const provider = createPublicDataProvider(staticClient(PERSONAL_TOKEN, net));
    const report = await runDataProviderConformance(provider);
    expect(report.providerId).toBe("public");
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.capability)).toEqual(["quotes", "optionsChains"]);
  });

  it("without a token the fetch fails honestly (no fabricated data)", async () => {
    const net = makeFakeNetwork();
    const provider = createPublicDataProvider(staticClient(null, net));
    await expect(provider.getQuote!("AAPL")).rejects.toThrow(PublicMcpError);
  });

  it("the env factory wires the SessionStore token source for the exact login", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicPersonalToken(env, LOGIN, PERSONAL_TOKEN);
    const net = makeFakeNetwork();
    vi.stubGlobal("fetch", net.fetchImpl);
    try {
      const provider = createPublicDataProviderFromEnv(env, LOGIN);
      const quote = await provider.getQuote!("AAPL");
      expect((quote.result as any).lastPrice).toBe(232.5);
      // #4035: after a PAT is stored, BOTH grounded capabilities serve
      // through the provider, and each result names public as its source.
      expect(quote.providerId).toBe("public");
      const expiries = await provider.getOptionExpiryDates!("AAPL");
      expect(expiries.providerId).toBe("public");
      expect(expiries.result).toEqual([
        { year: 2026, month: 1, day: 16 },
        { year: 2026, month: 2, day: 20 },
      ]);
      const chain = await provider.getOptionsChain!({
        symbol: "AAPL",
        expiryYear: 2026,
        expiryMonth: 1,
        expiryDay: 16,
      });
      expect(chain.providerId).toBe("public");
      expect((chain.result as any).pairs).toHaveLength(2);
      // A different login has no token: the provider refuses honestly
      // rather than borrowing another user's credential.
      const other = createPublicDataProviderFromEnv(env, "someone-else");
      await expect(other.getQuote!("AAPL")).rejects.toThrow(PublicMcpError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Registration + lifecycle: registered-available, refused until enabled
// ---------------------------------------------------------------------------

describe("public registration and lifecycle", () => {
  function routeCtx(sql: MockSqlStorage, env: Env): DataProviderRoutesContext {
    return {
      env,
      sql,
      userLogin: LOGIN,
      recordAudit: () => ({ id: "audit-1" }),
    };
  }

  async function callRoute(
    ctx: DataProviderRoutesContext,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const url = new URL(`https://agent.internal${path}`);
    const request = new Request(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return (await handleDataProviderRoutes(request, url, path, "session-1", ctx)) as Response;
  }

  it("GET /data-providers: the public adapter is registered-available with its capabilities; nothing resolves while seeded", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql);
    const res = await callRoute(routeCtx(sql, env), "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const pub = body.providers.find((p: any) => p.id === "public");
    expect(pub.declaredCapabilities).toEqual(["quotes", "optionsChains"]);
    expect(pub.lifecycleState).toBe("registered");
    // Ships disabled: with only the seeds in place, no route resolves.
    expect(body.routes.every((r: any) => r.resolves === false)).toBe(true);
  });

  it("registry: public refuses while not enabled, and serves after the lifecycle path + operator routing", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql);
    const net = makeFakeNetwork();
    const registry = new DataProviderRegistry();
    registry.register(createPublicDataProvider(staticClient(PERSONAL_TOKEN, net)));
    // Seeded "registered" state: resolution refuses.
    expect(() => registry.resolveRoute("quotes", listProviderConfigs(sql), listCapabilityRoutes(sql))).toThrow();

    // Lifecycle path through the service-level transitions the routes use:
    // configure (sessionstore ref) → verify (verifier stubbed at the client
    // seam via buildDataProviderVerifier's public branch, below) → enable.
    const ctx = routeCtx(sql, env);
    const configured = await callRoute(ctx, "POST", "/data-providers/public/configure", {
      credentialRef: suggestedPublicCredentialRef(LOGIN),
    });
    expect(configured.status).toBe(200);
    expect(getProviderConfig(sql, "public")?.lifecycleState).toBe("configured");

    // No token stored yet: the REAL verifier (module default binding)
    // fails honestly, and the record stays configured.
    vi.stubGlobal("fetch", net.fetchImpl);
    try {
      const failed = await callRoute(ctx, "POST", "/data-providers/public/verify");
      expect(failed.status).toBe(409);
      expect(getProviderConfig(sql, "public")?.lifecycleState).toBe("configured");

      // Store the user's token, then verify succeeds with evidence.
      await storePublicPersonalToken(env, LOGIN, PERSONAL_TOKEN);
      const verified = await callRoute(ctx, "POST", "/data-providers/public/verify");
      expect(verified.status).toBe(200);
      const record = getProviderConfig(sql, "public")!;
      expect(record.lifecycleState).toBe("verified");
      const evidence = getVerificationEvidence(record);
      expect(evidence?.summary).toMatch(/conformance passed/);

      const enabled = await callRoute(ctx, "POST", "/data-providers/public/enable");
      expect(enabled.status).toBe(200);

      // Operator routing act: compose public as the quotes primary.
      upsertCapabilityRoute(sql, { capability: "quotes", primaryProviderId: "public", gapFillProviderId: null });
      const assignment = registry.resolveRoute("quotes", listProviderConfigs(sql), listCapabilityRoutes(sql));
      expect(assignment.primary.id).toBe("public");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bootstrap is unchanged: only etrade is enabled by bootstrap; public stays registered", () => {
    const sql = new MockSqlStorage();
    bootstrapDataProviders(sql);
    const pub = getProviderConfig(sql, "public")!;
    expect(pub.lifecycleState).toBe("registered");
    expect(pub.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verifier (bound like etrade's)
// ---------------------------------------------------------------------------

describe("public verifier", () => {
  it("buildDataProviderVerifier binds public (and binds yahoo, nasdaq, and alpaca; unknown ids stay unbound)", () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    expect(buildDataProviderVerifier(env, LOGIN, "public", null)).toBeDefined();
    // #1317 binds the yahoo verifier (market-data isConfigured + conformance);
    // #1368 binds the nasdaq verifier (configured-by-construction +
    // conformance); #1385 binds the alpaca verifier (market-data
    // isConfigured + conformance). With all five providers bound,
    // the unbound case moves to an unknown provider id returning
    // undefined — the explicit-binding-matrix intent of this pin
    // is unchanged.
    expect(buildDataProviderVerifier(env, LOGIN, "yahoo")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "nasdaq")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "alpaca")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "no-such-provider")).toBeUndefined();
  });

  it("no credential reference ⇒ honest failure naming the missing reference", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const result = await verifyPublicDataProvider(env, LOGIN, null);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no credential reference/);
    expect(result.summary).toContain(suggestedPublicCredentialRef(LOGIN));
  });

  it("reference configured but no token stored ⇒ honest failure", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    const result = await verifyPublicDataProvider(env, LOGIN, suggestedPublicCredentialRef(LOGIN));
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no Public token/);
  });

  it("stored token + live seam ⇒ verified evidence (tools/list + conformance probe)", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicPersonalToken(env, LOGIN, PERSONAL_TOKEN);
    const net = makeFakeNetwork();
    const result = await verifyPublicDataProvider(env, LOGIN, suggestedPublicCredentialRef(LOGIN), {
      fetchImpl: net.fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/conformance passed/);
  });

  it("a rejected token fails verification with the reason, never a rubber stamp", async () => {
    const store = makeFakeSessionStore();
    const env = makeEnv(store);
    await storePublicPersonalToken(env, LOGIN, "bad-token");
    const net = makeFakeNetwork();
    const result = await verifyPublicDataProvider(env, LOGIN, suggestedPublicCredentialRef(LOGIN), {
      fetchImpl: net.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/rejected|401/);
  });
});
