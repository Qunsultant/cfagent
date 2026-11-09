/**
 * Issue #2349 (Agent Mesh S6, programme #2225 G1 batch B): typed
 * outbound doors from the orchestrator chat turn to TradingAgent
 * and ReportAssetAgent.
 *
 * Pins, at the binding seam (fake DO namespaces — the door itself is
 * never mocked away):
 * - dispatch reaches the acting user's OWN instance for both agents
 *   (trading:<login> / assets:<login>; the bare "trading" /
 *   "default" instances only for the configured service identity),
 *   with the acting identity threaded as the trading call's identity
 *   — never inside tool arguments;
 * - a proposal created through the door is the service's own
 *   pending_approval envelope, attributed to the acting user;
 * - no acting identity (absent, blank, or the retired "default"
 *   literal) fails closed BEFORE any stub is resolved or called;
 * - the door exposes NO execution surface: TradingAgent's approval
 *   door (executeApprovedOrder / startTradeApproval /
 *   decideTradeApproval) is not typed on the stub, not called by any
 *   door operation, and no turn command names an execute/approve
 *   path — order execution stays behind the existing approval door
 *   until S9/G4. (#2375/S9 has since crossed that boundary THROUGH
 *   the door: startTradeApproval / decideTradeApproval are now
 *   typed and door-called by design; the boundary that remains —
 *   and that the block below now pins — is that the synchronous
 *   settle, executeApprovedOrder, is never door-typed or
 *   door-called. The batch-B proposal/read surface is unchanged.);
 * - a report asset get shapes the stored asset as the A2A door does
 *   and an unknown key is an honest typed error, never an empty
 *   success;
 * - the seven turn commands are registered in McpToolFactory and
 *   each declares exactly one scope (#1744);
 * - the queued async-job path carries the acting identity into a
 *   batch-B command exactly as batch A established (#2341).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MeshDoorError,
  proposeStockTradeViaDoor,
  proposeOptionsTradeViaDoor,
  getTradingAccountsViaDoor,
  getTradingPositionsViaDoor,
  getTradingQuoteViaDoor,
  listReportAssetsViaDoor,
  getReportAssetViaDoor,
} from "../src/agents/orchestrator/meshDoors";
import {
  ProposeStockTradeCommand,
  RunStockScreenCommand,
  ProposeOptionsTradeCommand,
  GetTradingAccountsCommand,
  GetTradingPositionsCommand,
  GetTradingQuoteCommand,
  ListReportAssetsCommand,
  GetReportAssetCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { McpAgentToolAdapter } from "../src/agents/mcpAdapter";
import {
  submitAsyncJob,
  executeAsyncJob,
  ensureAsyncJobGraphColumns,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { ReportAssetMeta } from "../src/agents/report-asset-agent";
import type { McpToolContext } from "../src/patterns/interfaces";

// ---------------------------------------------------------------------------
// Binding-seam fakes
// ---------------------------------------------------------------------------

const STOCK_PROPOSAL_RESULT = {
  status: "pending_approval",
  proposal: {
    orderId: "ord-1001",
    symbol: "AAPL",
    action: "BUY",
    orderAction: "BUY",
    orderType: "MARKET",
    quantity: 10,
    estimatedPrice: 231.5,
    estimatedCommission: 0,
    estimatedTotal: 2315,
    term: "GOOD_FOR_DAY",
    status: "previewed",
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: "",
    proofSignature: "sig",
    previewMessage: "Preview generated",
  },
  note: "Preview only — no order was placed.",
};

const OPTIONS_PROPOSAL_RESULT = {
  status: "pending_approval",
  proposal: {
    orderId: "ord-2002",
    symbol: "AAPL",
    action: "BUY",
    orderAction: "BUY",
    brokerOrderType: "SPREADS",
    orderType: "LIMIT",
    quantity: 1,
    estimatedPrice: 3.2,
    estimatedCommission: 1.3,
    estimatedTotal: 321.3,
    term: "GOOD_FOR_DAY",
    status: "previewed",
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: "",
    proofSignature: "sig",
    previewMessage: "Preview generated",
  },
  note: "Preview only — no order was placed.",
};

const ACCOUNTS = [{ accountIdKey: "acc-1", accountDesc: "Individual" }];
const POSITIONS = { account: { accountIdKey: "acc-1" }, positions: [{ symbol: "AAPL", quantity: 10 }] };
const QUOTE = { symbol: "AAPL", lastPrice: 231.5 };

function makeTradingStub() {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async executeService(call: { serviceId: string; input?: Record<string, unknown>; userLogin?: string }) {
      this.calls.push({ method: "executeService", args: [call] });
      if (call.serviceId === "stock_trading") return JSON.parse(JSON.stringify(STOCK_PROPOSAL_RESULT));
      if (call.serviceId === "options_trading") return JSON.parse(JSON.stringify(OPTIONS_PROPOSAL_RESULT));
      throw new Error(`unexpected service: ${call.serviceId}`);
    },
    async getAccounts(provider?: string) {
      this.calls.push({ method: "getAccounts", args: [provider] });
      return ACCOUNTS;
    },
    async getPositions(accountKey?: string, provider?: string) {
      this.calls.push({ method: "getPositions", args: [accountKey, provider] });
      return POSITIONS;
    },
    async getQuote(symbol: string, provider?: string) {
      this.calls.push({ method: "getQuote", args: [symbol, provider] });
      return QUOTE;
    },
  };
}

const ASSET_METAS: ReportAssetMeta[] = [
  { key: "report:pdf:screener:bbb", fileName: "screener-report.pdf", storedAt: "2026-10-29T10:00:00.000Z" },
  { key: "report:pdf:research:aaa", fileName: "research-report.pdf", storedAt: "2026-10-28T09:00:00.000Z" },
];
const KNOWN_ASSET_KEY = "report:pdf:research:aaa";
const ASSET_BYTES = new Uint8Array([37, 80, 68, 70, 45]); // "%PDF-"

function makeReportAssetStub() {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async listAssets(limit = 50): Promise<ReportAssetMeta[]> {
      this.calls.push({ method: "listAssets", args: [limit] });
      return ASSET_METAS.slice(0, limit).map((m) => ({ ...m }));
    },
    async getAsset(key: string) {
      this.calls.push({ method: "getAsset", args: [key] });
      if (key === KNOWN_ASSET_KEY) return { bytes: ASSET_BYTES, fileName: "research-report.pdf" };
      return null;
    },
  };
}

function fakeNamespace<T>(stub: T, seen: string[]) {
  return {
    idFromName: (name: string) => {
      seen.push(name);
      return name;
    },
    get: (_id: unknown) => stub,
  };
}

function makeDoorEnv() {
  const tradingSeen: string[] = [];
  const reportSeen: string[] = [];
  const trading = makeTradingStub();
  const reports = makeReportAssetStub();
  const env = {
    TRADING_AGENT: fakeNamespace(trading, tradingSeen),
    REPORT_ASSET_AGENT: fakeNamespace(reports, reportSeen),
    SERVICE_USER_LOGIN: "svc-background",
  } as any;
  return { env, trading, reports, tradingSeen, reportSeen };
}

// ---------------------------------------------------------------------------
// Door dispatch: TradingAgent
// ---------------------------------------------------------------------------

describe("mesh doors: TradingAgent door (#2349)", () => {
  it("creates a stock proposal on the acting user's own instance, identity threaded at call level", async () => {
    const { env, trading, tradingSeen } = makeDoorEnv();
    const result = await proposeStockTradeViaDoor(env, "alice", {
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
    });
    expect(tradingSeen).toEqual(["trading:alice"]);
    expect(trading.calls).toHaveLength(1);
    const call = trading.calls[0].args[0] as {
      serviceId: string;
      userLogin?: string;
      input: Record<string, unknown>;
    };
    expect(call.serviceId).toBe("stock_trading");
    // Attribution: the call carries the acting identity; the service
    // input deliberately carries NO userLogin — identity is never
    // taken from (or smuggled through) tool-shaped arguments.
    expect(call.userLogin).toBe("alice");
    expect(call.input).toEqual({ symbol: "AAPL", action: "BUY", quantity: 10 });
    expect(call.input).not.toHaveProperty("userLogin");
    // The proposal is the service's own pending-approval envelope.
    expect(result.status).toBe("pending_approval");
    expect(result.proposal.orderId).toBe("ord-1001");
    expect(result.proposal.symbol).toBe("AAPL");
  });

  it("creates an options proposal with its legs through the options_trading service", async () => {
    const { env, trading } = makeDoorEnv();
    const legs = [
      {
        underlyingSymbol: "AAPL",
        securityType: "OPTN" as const,
        side: "BUY" as const,
        quantity: 1,
        optionType: "CALL" as const,
        strike: 230,
        expirationDate: "2026-11-20",
      },
    ];
    const result = await proposeOptionsTradeViaDoor(env, "alice", {
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 3.2,
      optionLegs: legs,
    });
    const call = trading.calls[0].args[0] as { serviceId: string; input: Record<string, unknown> };
    expect(call.serviceId).toBe("options_trading");
    expect(call.input.optionLegs).toEqual(legs);
    expect(result.status).toBe("pending_approval");
    expect(result.proposal.orderId).toBe("ord-2002");
  });

  it("reads accounts, positions, and a quote through the door, verbatim", async () => {
    const { env, trading } = makeDoorEnv();
    await expect(getTradingAccountsViaDoor(env, "alice")).resolves.toEqual(ACCOUNTS);
    await expect(getTradingPositionsViaDoor(env, "alice", { accountKey: "acc-1" })).resolves.toEqual(POSITIONS);
    await expect(getTradingQuoteViaDoor(env, "alice", { symbol: "AAPL" })).resolves.toEqual(QUOTE);
    expect(trading.calls.map((c) => c.method)).toEqual(["getAccounts", "getPositions", "getQuote"]);
    expect(trading.calls[1].args).toEqual(["acc-1", undefined]);
    expect(trading.calls[2].args).toEqual(["AAPL", undefined]);
  });

  it("addresses the service identity to the bare 'trading' instance", async () => {
    const { env, tradingSeen } = makeDoorEnv();
    await getTradingAccountsViaDoor(env, "svc-background");
    expect(tradingSeen).toEqual(["trading"]);
  });

  it("propagates the agent's own typed errors unchanged (never converted to success)", async () => {
    const thrown = Object.assign(new Error("Provider \"yahoo\" does not support order preview."), {
      name: "TradingServiceError",
      code: "provider_unsupported",
    });
    const stub = makeTradingStub();
    stub.executeService = async () => {
      throw thrown;
    };
    const env = { TRADING_AGENT: fakeNamespace(stub, []), SERVICE_USER_LOGIN: "svc-background" } as any;
    const err = await proposeStockTradeViaDoor(env, "alice", {
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      provider: "yahoo",
    }).catch((e) => e);
    expect(err).toBe(thrown);
    expect(err.code).toBe("provider_unsupported");
  });

  it("an unbound namespace fails honestly (door_unavailable), never a fabricated result", async () => {
    const err = await getTradingAccountsViaDoor({ SERVICE_USER_LOGIN: "svc-background" } as any, "alice").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Door dispatch: ReportAssetAgent
// ---------------------------------------------------------------------------

describe("mesh doors: ReportAssetAgent door (#2349)", () => {
  it("lists the acting user's assets from their own assets:<login> instance", async () => {
    const { env, reports, reportSeen } = makeDoorEnv();
    const result = await listReportAssetsViaDoor(env, "alice", 10);
    expect(reportSeen).toEqual(["assets:alice"]);
    expect(reports.calls).toEqual([{ method: "listAssets", args: [10] }]);
    expect(result.assets.map((a) => a.key)).toEqual([
      "report:pdf:screener:bbb",
      "report:pdf:research:aaa",
    ]);
  });

  it("addresses the service identity to the 'default' instance", async () => {
    const { env, reportSeen } = makeDoorEnv();
    await listReportAssetsViaDoor(env, "svc-background");
    expect(reportSeen).toEqual(["default"]);
  });

  it("gets one asset shaped as the A2A door shapes it (key, fileName, byteLength, bytesBase64)", async () => {
    const { env } = makeDoorEnv();
    const result = await getReportAssetViaDoor(env, "alice", KNOWN_ASSET_KEY);
    expect(result.key).toBe(KNOWN_ASSET_KEY);
    expect(result.fileName).toBe("research-report.pdf");
    expect(result.byteLength).toBe(ASSET_BYTES.length);
    expect(new Uint8Array(Buffer.from(result.bytesBase64, "base64"))).toEqual(ASSET_BYTES);
  });

  it("an unknown key is an honest typed error (asset_not_found), never an empty success", async () => {
    const { env } = makeDoorEnv();
    const err = await getReportAssetViaDoor(env, "alice", "report:pdf:nope").catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("asset_not_found");
  });

  it("an unbound namespace fails honestly (door_unavailable)", async () => {
    const err = await listReportAssetsViaDoor({ SERVICE_USER_LOGIN: "svc-background" } as any, "alice").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Identity discipline: fail closed before dispatch
// ---------------------------------------------------------------------------

describe("mesh doors batch B: identity fails closed before dispatch (#2349)", () => {
  const BAD_IDENTITIES: Array<string | undefined> = [undefined, "", "   ", "default"];

  it("every batch-B door operation refuses a missing/blank/retired identity before resolving any stub", async () => {
    for (const bad of BAD_IDENTITIES) {
      const { env, trading, reports, tradingSeen, reportSeen } = makeDoorEnv();
      const attempts: Array<() => Promise<unknown>> = [
        () => proposeStockTradeViaDoor(env, bad, { symbol: "AAPL", action: "BUY", quantity: 1 }),
        () =>
          proposeOptionsTradeViaDoor(env, bad, {
            symbol: "AAPL",
            action: "BUY",
            quantity: 1,
            optionLegs: [{ underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1 }],
          }),
        () => getTradingAccountsViaDoor(env, bad),
        () => getTradingPositionsViaDoor(env, bad, {}),
        () => getTradingQuoteViaDoor(env, bad, { symbol: "AAPL" }),
        () => listReportAssetsViaDoor(env, bad),
        () => getReportAssetViaDoor(env, bad, KNOWN_ASSET_KEY),
      ];
      for (const attempt of attempts) {
        const err = await attempt().catch((e) => e);
        expect(err).toBeInstanceOf(MeshDoorError);
        expect(err.code).toBe("identity_required");
      }
      expect(tradingSeen).toEqual([]);
      expect(reportSeen).toEqual([]);
      expect(trading.calls).toEqual([]);
      expect(reports.calls).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The hard boundary: no execution surface
// ---------------------------------------------------------------------------

describe("mesh doors batch B: the approval-door boundary, as re-scoped by S9 (#2349, #2375)", () => {
  it("no door module source calls the synchronous settle — the workflow's step is its only caller", () => {
    for (const file of ["src/agents/orchestrator/meshDoors.ts", "src/mcps/openaimp/meshDoorCommands.ts"]) {
      const text = readFileSync(join(__dirname, "..", file), "utf8");
      expect(text, file).not.toMatch(/\.executeApprovedOrder\s*\(/);
    }
    // #2375: start/decide ARE door-called by design now — the door
    // crosses the approval boundary through the door itself.
    const doors = readFileSync(join(__dirname, "../src/agents/orchestrator/meshDoors.ts"), "utf8");
    expect(doors).toMatch(/\.startTradeApproval\s*\(/);
    expect(doors).toMatch(/\.decideTradeApproval\s*\(/);
  });

  it("the TradingAgent door stub types the workflow operations but never the synchronous settle", () => {
    const text = readFileSync(join(__dirname, "../src/agents/orchestrator/meshDoors.ts"), "utf8");
    const start = text.indexOf("interface TradingAgentDoorStub");
    const end = text.indexOf("export function getTradingAgentDoor", start);
    const block = text.slice(start, end);
    expect(block).toContain("executeService");
    // A signature check, not a word check: the stub's own comment
    // names the settle to say it is NOT typed here.
    expect(block).not.toMatch(/executeApprovedOrder\s*\(/);
    expect(block).toContain("startTradeApproval");
    expect(block).toContain("decideTradeApproval");
  });

  it("no batch-B command name carries an execute/approve/decide path", () => {
    const names = [
      new ProposeStockTradeCommand().name,
      new ProposeOptionsTradeCommand().name,
      new GetTradingAccountsCommand().name,
      new GetTradingPositionsCommand().name,
      new GetTradingQuoteCommand().name,
      new ListReportAssetsCommand().name,
      new GetReportAssetCommand().name,
    ];
    for (const name of names) {
      expect(name).not.toMatch(/execute|approve|decide|place|cancel/);
    }
  });
});

// ---------------------------------------------------------------------------
// Turn commands: thin resolve-identity -> dispatch, one scope each
// ---------------------------------------------------------------------------

function makeCommandContext(env: any, actingLogin?: () => string | undefined): McpToolContext {
  return {
    env,
    orm: {} as any,
    sessionId: "session-1",
    audit: vi.fn(),
    ...(actingLogin ? { actingLogin } : {}),
  } as McpToolContext;
}

describe("mesh door commands batch B (#2349)", () => {
  it("propose_stock_trade dispatches through the door with the turn's acting identity and audits attribution", async () => {
    const { env, trading } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    const result = await new ProposeStockTradeCommand().execute(
      { symbol: "AAPL", action: "BUY", quantity: 10 },
      ctx,
    );
    expect(result.status).toBe("pending_approval");
    expect(result.proposal.orderId).toBe("ord-1001");
    const call = trading.calls[0].args[0] as { userLogin?: string };
    expect(call.userLogin).toBe("alice");
    expect(ctx.audit).toHaveBeenCalledWith(
      "propose_stock_trade",
      "mcp",
      expect.objectContaining({ actingLogin: "alice", orderId: "ord-1001", status: "pending_approval" }),
    );
  });

  it("a command with no acting-identity carrier refuses before dispatch", async () => {
    const { env, trading } = makeDoorEnv();
    const ctx = makeCommandContext(env);
    const err = await new ProposeStockTradeCommand()
      .execute({ symbol: "AAPL", action: "BUY", quantity: 1 }, ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(trading.calls).toEqual([]);
  });

  it("a command whose turn identity is the retired 'default' literal refuses", async () => {
    const { env, reports } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "default");
    const err = await new ListReportAssetsCommand().execute({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(reports.calls).toEqual([]);
  });

  it("all seven commands reach their door operations", async () => {
    const { env, trading, reports } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    await new ProposeStockTradeCommand().execute({ symbol: "AAPL", action: "BUY", quantity: 10 }, ctx);
    await new ProposeOptionsTradeCommand().execute(
      {
        symbol: "AAPL",
        action: "BUY",
        quantity: 1,
        optionLegs: [{ underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1 }],
      },
      ctx,
    );
    await new GetTradingAccountsCommand().execute({}, ctx);
    await new GetTradingPositionsCommand().execute({}, ctx);
    await new GetTradingQuoteCommand().execute({ symbol: "AAPL" }, ctx);
    await new ListReportAssetsCommand().execute({}, ctx);
    const asset = await new GetReportAssetCommand().execute({ key: KNOWN_ASSET_KEY }, ctx);
    expect(asset.fileName).toBe("research-report.pdf");
    expect(trading.calls.map((c) => c.method)).toEqual([
      "executeService",
      "executeService",
      "getAccounts",
      "getPositions",
      "getQuote",
    ]);
    expect(reports.calls.map((c) => c.method)).toEqual(["listAssets", "getAsset"]);
  });

  it("all seven commands are factory-registered, each with exactly one declared scope", () => {
    const expected: Record<string, string> = {
      propose_stock_trade: "mcp:trade",
      propose_options_trade: "mcp:trade",
      get_trading_accounts: "mcp:read",
      get_trading_positions: "mcp:read",
      get_trading_quote: "mcp:read",
      list_report_assets: "mcp:read",
      get_report_asset: "mcp:read",
    };
    for (const [name, scope] of Object.entries(expected)) {
      expect(McpToolFactory.getTool(name), name).toBeDefined();
      expect(MCP_TOOL_SCOPES[name], name).toBe(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Identity carriage: adapter stamp -> job payload -> executor -> door
// ---------------------------------------------------------------------------

describe("mesh door identity carriage for batch B (#2349)", () => {
  it("the turn adapter stamps the acting identity into the queued job payload", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "job-1",
      status: "queued",
      statusUrl: "/api/jobs/job-1",
    });
    const { env } = makeDoorEnv();
    const ctx = {
      ...makeCommandContext(env, () => "alice"),
      principal: { kind: "agent-turn" as const, login: null },
      submitJob,
    } as McpToolContext;
    // Issue #3839: propose_stock_trade is synchronous (a money path is
    // never queued). The adapter's queue-identity contract is covered by
    // an async screen tool, which still travels through the job payload.
    const tool = McpAgentToolAdapter.adapt(new RunStockScreenCommand(), ctx);
    await (tool as any).execute(
      { universe: "SP500" },
      { toolCallId: "t-1", messages: [] },
    );
    expect(submitJob).toHaveBeenCalledTimes(1);
    const job = submitJob.mock.calls[0][0];
    expect(job.capability).toBe("mcp.tool");
    expect(job.payload.toolName).toBe("run_stock_screen");
    expect(job.payload.actingLogin).toBe("alice");
  });
});

// A mutating in-memory mas_async_jobs fake (the async_job_graph /
// feed-chain harness pattern, as in the batch-A suite): enough SQL
// fidelity for the real submit + execute path — INSERT/SELECT
// projection, status-guarded claim UPDATE, completion/failure
// UPDATEs applied to the rows.
class FakeJobSql {
  columns: string[] = [];
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const done = (rows: Array<Record<string, unknown>> = [], rowsWritten = 0) =>
      Object.assign([...rows], { rowsWritten });
    if (/^CREATE TABLE/i.test(q)) {
      this.columns = [
        "job_id", "session_id", "capability", "display_name", "status",
        "payload_json", "result_json", "response_status", "error",
        "created_at", "updated_at", "started_at", "completed_at",
      ];
      return done();
    }
    if (/^PRAGMA table_info/i.test(q)) {
      return Object.assign(this.columns.map((name) => ({ name })), { rowsWritten: 0 });
    }
    const alter = q.match(/^ALTER TABLE mas_async_jobs ADD COLUMN (\w+)/i);
    if (alter) {
      if (!this.columns.includes(alter[1])) this.columns.push(alter[1]);
      return done();
    }
    if (/^CREATE INDEX/i.test(q)) return done();
    if (/^DELETE FROM mas_async_jobs/i.test(q)) return done([], 0);
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const valuesPart = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let argIndex = 0;
      cols.forEach((col, i) => {
        const token = valuesPart[i];
        row[col] = token === "?" ? (args[argIndex++] ?? null) : token.replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return done([], 1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assignments = setPart.split(",").map((s) => s.trim());
      let argIndex = 0;
      const updates: Record<string, unknown> = {};
      for (const assignment of assignments) {
        const m = assignment.match(/^(\w+) = (.+)$/)!;
        const [, col, rhs] = m;
        updates[col] = rhs === "?" ? args[argIndex++] : rhs.replace(/^'|'$/g, "");
      }
      // Remaining args are the WHERE parameters: job_id first.
      const jobId = args[argIndex];
      const row = this.rows.find((r) => r.job_id === jobId);
      if (!row) return done([], 0);
      if (/WHERE .*status = 'queued'/i.test(q) && row.status !== "queued") return done([], 0);
      Object.assign(row, updates);
      return done([], 1);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM mas_async_jobs/i);
      if (!listMatch) return done();
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...this.rows];
      if (/WHERE job_id = \?/i.test(q)) rows = rows.filter((r) => r.job_id === args[0]);
      if (/ORDER BY created_at DESC/i.test(q)) {
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      const projected = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      });
      return done(projected);
    }
    throw new Error(`FakeJobSql: unsupported query: ${q.slice(0, 100)}`);
  }
}

function makeExecutorCtx(sql: FakeJobSql, env: any): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  return {
    env,
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => {
      sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
      ensureAsyncJobGraphColumns(storage);
      return storage;
    },
    sessionKey: () => "session-1",
    schedule: vi.fn(async () => ({})),
    audit: vi.fn(),
    getOrm: () => orm,
    routeRequest: vi.fn(async () => new Response("{}")),
    nlqSchedulingPort: () => ({}),
    nlqStockScreenPort: () => ({}),
    followupReportPort: () => ({
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
  } as unknown as AsyncJobsContext;
}

describe("mesh doors batch B: queued turn call executes through the door (#2349)", () => {
  it("a job stamped with the acting identity completes with the door's real proposal", async () => {
    const sql = new FakeJobSql();
    const { env, trading, tradingSeen } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: {
        toolName: "propose_stock_trade",
        arguments: { symbol: "AAPL", action: "BUY", quantity: 10 },
        actingLogin: "alice",
      },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("completed");
    const result = JSON.parse(String(row?.result_json));
    expect(result.status).toBe("pending_approval");
    expect(result.proposal.orderId).toBe("ord-1001");
    expect(tradingSeen).toEqual(["trading:alice"]);
    const call = trading.calls[0].args[0] as { userLogin?: string };
    expect(call.userLogin).toBe("alice");
  });

  it("a job without an acting identity fails closed and never reaches the agent", async () => {
    const sql = new FakeJobSql();
    const { env, trading, tradingSeen } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: {
        toolName: "propose_stock_trade",
        arguments: { symbol: "AAPL", action: "BUY", quantity: 10 },
      },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/identity/i);
    expect(tradingSeen).toEqual([]);
    expect(trading.calls).toEqual([]);
  });
});
