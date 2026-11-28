/**
 * Consolidation #1236 (feed seam): the feed stage job's work — produce
 * + store one artifact per symbol, and plan the generate stage from a
 * completed feed.
 *
 * Handler idiom follows shard.execute: the async-job executor owns
 * job state; this module owns the work. The broker enters only
 * through the injected createETradeService port, exactly like the
 * shard handler.
 *
 * Job-result contract: the result carries descriptors, NOT snapshot
 * bytes (the 12 MB job-result limit) — the bytes live in
 * mas_feed_snapshots. All symbols failed ⇒ throw, so the job row
 * reads failed and the chain stops (the completion hook never runs).
 * Partial ⇒ a completed job whose result names the failures; the
 * hook still plans generate, and generate resolves per symbol, so
 * the unfed symbols fail honestly at generate instead of blocking
 * the fed ones.
 */
import { OptionsDataAgent } from "../trading";
import { DynamicOptionsScreener } from "../trading";
import { produceFeedSnapshot } from "./feedSnapshotProducer";
import type { FeedSnapshotLoadParams } from "./feedSnapshotStore";
import { createOptionsDiscoveryPorts } from "../data/createOptionsDiscoveryPorts";
import type { StrategyRequest } from "../trading";

export interface FeedSnapshotJobPayload {
  userLogin: string;
  environment?: string;
  symbols: Array<{ symbol: string; loadParams?: FeedSnapshotLoadParams }>;
  /** When present, feed completion plans a generate stage running
   *  these requests against the fresh artifacts. */
  chainTo?: {
    requests: StrategyRequest[];
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
  };
}

export interface FeedSnapshotJobResult {
  status: "completed" | "partial";
  artifacts: Array<{
    artifactId: string;
    symbol: string;
    asOf: string;
    dataSource: string;
    contractCount: number;
    loadParams: FeedSnapshotLoadParams;
  }>;
  failures: Array<{ symbol: string; error: string }>;
  chainTo?: FeedSnapshotJobPayload["chainTo"];
  reason?: string;
}

const TICKER_RE = /^[A-Z0-9./-]{1,16}$/i;

export async function executeFeedSnapshotJob(
  deps: {
    sql: { exec(query: string, ...params: unknown[]): Iterable<unknown> };
    env: unknown;
    orm: unknown;
    createETradeService: (userLogin: string, environment?: string) => { client: unknown };
    sessionId: string;
    /** #6558: the async-job execution deadline's abort signal, when
     *  the feed snapshot runs as a job leg (the executor binds it).
     *  The internal provider fetches do not consume it yet —
     *  follow-up work; this field is the seam they consume it
     *  through. */
    signal?: AbortSignal;
  },
  payload: FeedSnapshotJobPayload,
): Promise<FeedSnapshotJobResult> {
  const userLogin = typeof payload?.userLogin === "string" ? payload.userLogin : "";
  if (!userLogin) throw new Error("feed.snapshot job requires a userLogin.");
  if (!Array.isArray(payload?.symbols) || payload.symbols.length === 0) {
    throw new Error("feed.snapshot job requires at least one symbol.");
  }
  for (const entry of payload.symbols) {
    if (typeof entry?.symbol !== "string" || !TICKER_RE.test(entry.symbol.trim())) {
      throw new Error(`feed.snapshot job requires valid ticker symbols; got '${String(entry?.symbol)}'.`);
    }
  }
  const store = createOptionsDiscoveryPorts({ sql: deps.sql }).feedSnapshots;
  const etrade = deps.createETradeService(userLogin, payload.environment);
  const agent = new OptionsDataAgent(
    new DynamicOptionsScreener(etrade.client as never),
  );
  const artifacts: FeedSnapshotJobResult["artifacts"] = [];
  const failures: FeedSnapshotJobResult["failures"] = [];
  for (const entry of payload.symbols) {
    const symbol = entry.symbol.toUpperCase().trim();
    try {
      const descriptor = await produceFeedSnapshot({
        store,
        userLogin,
        symbol,
        loadSnapshot: (params) => agent.loadSnapshot(params as never),
        loadParams: entry.loadParams,
      });
      artifacts.push(descriptor);
    } catch (err) {
      failures.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (artifacts.length === 0) {
    throw new Error(
      `Feed snapshot failed for every symbol (${failures.map((f) => `${f.symbol}: ${f.error}`).join("; ")})`,
    );
  }
  const partial = failures.length > 0;
  return {
    status: partial ? "partial" : "completed",
    artifacts,
    failures,
    ...(payload.chainTo ? { chainTo: payload.chainTo } : {}),
    ...(partial
      ? { reason: `partial feed: ${failures.map((f) => f.symbol).join(", ")} failed` }
      : {}),
  };
}

/**
 * Pure completion planning: a completed feed with a chainTo spec and
 * at least one artifact plans exactly one generate stage — an
 * http.request job to the discovery trigger route, carrying the
 * fresh artifacts map. No chainTo or no artifacts ⇒ no specs (a
 * standalone refresh plans nothing downstream).
 */
export function planFeedGenerateJobs(args: {
  feedJobId: string;
  chainId: string;
  userLogin: string;
  environment?: string;
  result: FeedSnapshotJobResult;
}): Array<{
  capability: "http.request";
  payload: {
    pathAndQuery: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  stage: "generate";
  chainId: string;
  parentJobId: string;
}> {
  const { result } = args;
  if (!result.chainTo || result.artifacts.length === 0) return [];
  const artifacts: Record<string, string> = {};
  for (const artifact of result.artifacts) {
    artifacts[artifact.symbol.toUpperCase().trim()] = artifact.artifactId;
  }
  const triggerBody: Record<string, unknown> = {
    requests: result.chainTo.requests,
    snapshotInput: { artifacts },
  };
  if (result.chainTo.emailTo !== undefined) triggerBody.emailTo = result.chainTo.emailTo;
  if (result.chainTo.slackChannel !== undefined) triggerBody.slackChannel = result.chainTo.slackChannel;
  if (result.chainTo.webhookUrl !== undefined) triggerBody.webhookUrl = result.chainTo.webhookUrl;
  const headers: Record<string, string> = { "x-user-login": args.userLogin };
  if (args.environment) headers["x-environment"] = args.environment;
  return [{
    capability: "http.request",
    payload: {
      pathAndQuery: "/api/schedules/trigger-discovery",
      method: "POST",
      headers,
      body: JSON.stringify(triggerBody),
    },
    stage: "generate",
    chainId: args.chainId,
    parentJobId: args.feedJobId,
  }];
}
