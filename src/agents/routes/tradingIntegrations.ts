/**
 * Issue #359-10: trading integrations routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the omnichannel trading channel block:
 * POST /trading/email/inbound,
 * POST /trading/slack/event, POST /trading/slack/interaction, POST /trading/slack/command,
 * POST /trading/browser/transaction-snap (also POST /browser/transaction-snap),
 * POST /trading/voice/turn, GET /trading/voice/greeting.
 * The seven blocks were contiguous in routeRequest (between the E*TRADE broker
 * routes block and the broker activity delegation), so this module exports ONE
 * handler invoked from routeRequest at the EXACT position the original blocks
 * occupied in the sequential matching sequence. It returns a Response when
 * one of its paths matches, or null when none does - matching order relative
 * to all other handlers is preserved by the call site.
 *
 * BOUNDARY DISCIPLINE (#290): ETradeEmailTradingService,
 * ETradeSlackTradingService and ETradeVoiceTradingService are imported ONLY
 * through the src/trading/index.ts boundary ("../trading"), exactly as the
 * inline code did. No direct imports of trading internals.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * TradingIntegrationsRouteContext parameter; there are no new globals and
 * no back-references into the class.
 */

import type { AgentContext } from "agents";
import { BrowserAgent } from "../browserAgent";
import { TradingPlatformRegistry } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { brokerPresentation } from "../../trading";
import {
  ETradeEmailTradingService,
  ETradeSlackTradingService,
  ETradeVoiceTradingService,
} from "../../trading";
import {
  parseAuthenticationResults,
  resolvePrincipal,
  slackPrincipalLinkStoreFromEnv,
  type ChannelNlqDeps,
  type ChannelPrincipal,
} from "../../trading";
import { OrmReplayStore } from "../../security/webhookReplay";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { createDiscoveryService } from "../../services/discoveryService";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { createFitDiscoveryRunner } from "../../services/fitDiscoveryRunner";
import type { TransactionSnapData } from "../../types";
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { AgentName } from "../../types";
import type { NLQSchedulingPort } from "../nlq";

/** The subset of OrchestratorAgent surface the trading-integrations handlers need. */
export interface TradingIntegrationsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Audit writer (owner: OrchestratorAgent - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * forwarded to the BrowserAgent constructor. */
  agentCtx: AgentContext;
  /** NLQ scheduling port (owner: OrchestratorAgent - was `this.nlqSchedulingPort()`). */
  nlqSchedulingPort(): NLQSchedulingPort;
  /** DO storage SQL (owner: OrchestratorAgent - was `this.ctx.storage.sql`). */
  getStorageSql(): any;
}

/**
 * Issue #3429: the channel desks are E*TRADE-shaped services.
 *
 * `src/trading/email/agent.ts`, `src/trading/slack/agent.ts` and
 * `src/trading/voice/agent.ts` each construct an ETradeService and use it
 * for preview, quotes, screening AND execution. There is no neutral equivalent
 * to hand them: a partial swap would let an E*TRADE-priced preview execute at
 * another venue, which is a worse defect than an honest refusal.
 *
 * So the gate runs FIRST, before any service is constructed. A tenant whose
 * selected broker is not E*TRADE gets a coded refusal naming the selection and
 * the surface to use instead. Nothing is previewed, quoted from another
 * broker, or routed.
 */
export const CHANNEL_BROKER_UNAVAILABLE = "BROKER_CHANNEL_UNAVAILABLE";

/** The paths that reach an ETradeService instance. */
export const CHANNEL_DESK_PATHS = [
  "/trading/email/inbound",
  "/trading/email/approve-link",
  "/trading/slack/event",
  "/trading/slack/interaction",
  "/trading/slack/command",
  "/trading/voice/turn",
  "/trading/voice/greeting",
] as const;

/** True when this path would construct an E*TRADE-shaped channel service. */
export function isChannelDeskPath(path: string): boolean {
  return CHANNEL_DESK_PATHS.some((candidate) => path.endsWith(candidate));
}

/** The coded refusal. Names the broker; never renders another broker's data. */
export function channelBrokerRefusal(broker: string): Response {
  const label = brokerPresentation(broker).label;
  return Response.json(
    {
      code: CHANNEL_BROKER_UNAVAILABLE,
      broker,
      message:
        `The email, Slack and voice trading desks execute against E*TRADE; your selected broker is ${label}. ` +
        `Nothing was previewed and no order was routed. Use the Trading Hub or the neutral order API ` +
        `(/api/broker/order/execute) for ${label}.`,
      retryable: false,
    },
    { status: 501 },
  );
}

/**
 * Issue #1262 Phase 4: the NLQ dependency set for channel services —
 * the web-chat set (scan + profile stores, scheduling port, discovery
 * runners) minus the social-brief port, which web chat withholds from
 * untrusted-origin NLQ (#1077 slice 2: a brief is a public-post input,
 * and channel messages are untrusted inbound content). The userLogin
 * is the resolved principal's login (never a session/instance id).
 */
async function buildChannelNlqDeps(
  ctx: TradingIntegrationsRouteContext,
  orm: DatabaseORM,
  userLogin: string
): Promise<ChannelNlqDeps> {
  const sql = ctx.getStorageSql();
  // #2303: the discovery runner's history resolution runs
  // through the platform ports when AGENT_DB is bound.
  const dpPorts = await buildDataProviderPorts(ctx.env);
  return {
    scanRunStore: createOptionsDiscoveryPorts({ sql, storage: ctx.agentCtx.storage }).scanRuns,
    profileStore: createOptionsDiscoveryPorts({ sql, storage: ctx.agentCtx.storage }).strategyProfiles,
    schedulingPort: ctx.nlqSchedulingPort(),
    discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin, orm, sql, blobStorage: ctx.agentCtx.storage, platform: TradingPlatformRegistry.getPlatform(await resolveTenantBroker(ctx.env), ctx.env, orm, userLogin), ...(dpPorts.config ? { configPort: dpPorts.config } : {}), ...(dpPorts.captures ? { capturePort: dpPorts.captures } : {}) }),
    fitDiscoveryRunner: createFitDiscoveryRunner({ env: ctx.env, userLogin, sql, storage: ctx.agentCtx.storage }),
  };
}

/**
 * Handles the omnichannel trading integration routes (email / slack /
 * browser / voice). Returns a Response on match, null when no integration
 * path matches (the orchestrator then continues its sequential matching).
 */
export async function handleTradingIntegrationsRoutes(
  request: Request,
  _url: URL,
  path: string,
  sessionId: string,
  ctx: TradingIntegrationsRouteContext
): Promise<Response | null> {
  // Issue #3429: refuse a non-E*TRADE tenant BEFORE any channel service is
  // constructed, so no preview, quote or order can reach another venue.
  if (isChannelDeskPath(path)) {
    const selectedBroker = await resolveTenantBroker(ctx.env);
    if (selectedBroker !== "etrade") return channelBrokerRefusal(selectedBroker);
  }
  // Omnichannel Trading Channel: Inbound Email Trading Agent
  if (path.endsWith("/trading/email/inbound") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: identity is the RESOLVED channel principal,
      // never a fallback literal. Two entry shapes reach this route:
      // (a) the session-authenticated simulator (server.ts requireAuth
      // forwards to the caller's OWN instance with x-user-login set to
      // the verified session login): the session IS the principal, at
      // trade tier. (b) the Cloudflare email forward, which asserts no
      // identity header: resolve from the payload — sender →
      // CHANNEL_EMAIL_PRINCIPALS, gated by Authentication-Results.
      // Unmapped (null) still constructs the service so the sender gets
      // an explicit refusal reply; it runs nothing.
      const headerLogin = request.headers.get("x-user-login");
      let principal: ChannelPrincipal | null;
      if (headerLogin) {
        principal = {
          userLogin: headerLogin,
          authorizerDid: `did:user:email:${typeof body.from === "string" && body.from ? body.from : headerLogin}`,
          tier: "trade",
        };
      } else {
        principal = await resolvePrincipal(ctx.env, {
          channel: "email",
          channelUserId: typeof body.from === "string" ? body.from : "",
          text: `${body.subject || ""}\n${body.text || body.html || ""}`,
          authProof: parseAuthenticationResults(
            typeof body.authenticationResults === "string" ? body.authenticationResults : undefined
          ),
        });
      }
      const orm = ctx.getOrm();
      const emailService = new ETradeEmailTradingService(
        ctx.env,
        orm,
        sessionId,
        principal,
        await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? sessionId)
      );
      const result = await emailService.processInboundEmail(body);
      ctx.audit("trading.email_processed", "trading", { actionType: result.actionType, from: result.from, orderId: result.orderId });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process inbound email" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Signed Email Approval Link Click
  // (Issue #1262 Phase 5). The worker route GET /api/trading/email/approve
  // verifies the token's shape, then forwards here, where the token is
  // verified again (signature + expiry + principal-map re-check) and
  // the order executes through the shared engine. The DO holds the
  // ledger, so execution must happen here, not in the worker.
  if (path.endsWith("/trading/email/approve-link") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const token = typeof body.token === "string" ? body.token : "";
      const emailService = new ETradeEmailTradingService(ctx.env, ctx.getOrm(), sessionId);
      const result = await emailService.executeSignedApprovalLink(token);
      ctx.audit("trading.email_approve_link", "trading", { orderId: result.orderId, status: result.status });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process signed approval link" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Event Handler
  if (path.endsWith("/trading/slack/event") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #2412 (Agent Mesh S13, G10): Slack event-delivery dedup.
      // Slack retries event deliveries that are not acked promptly;
      // before this claim, a retried event_callback was fully
      // reprocessed (duplicate NLQ runs, duplicate replies, repeated
      // approval attempts). The claim reuses the #143 replay store
      // (OrmReplayStore over the host instance's ORM — the same
      // nonce-claim mechanism the trading/NLQ webhooks use), keyed by
      // the delivery's event_id, and runs BEFORE principal resolution
      // or any service construction: a duplicate is acked with no
      // agent work. Deliveries without an event_id (url_verification,
      // synthetic simulator posts) are not claimed and flow as before.
      if (body.type === "event_callback" && typeof body.event_id === "string" && body.event_id) {
        const isReplay = await new OrmReplayStore(ctx.getOrm()).claim(
          `slack_event:${body.event_id}`,
          "slack",
          24 * 60 * 60 * 1000
        );
        if (isReplay) {
          ctx.audit("trading.slack_event_duplicate", "trading", {
            eventId: body.event_id,
            teamId: typeof body.team_id === "string" ? body.team_id : undefined,
          });
          return Response.json({ handled: false, actionType: "duplicate", eventId: body.event_id });
        }
      }
      // Issue #1262 Phase 1: identity is the RESOLVED channel principal
      // (connect-code link store: team_id + user_id → login). The
      // session-authenticated test simulator is the only forwarder that
      // sets x-user-login (to the verified session login, routed to the
      // caller's own instance): a session principal at trade tier. The
      // public webhook forward asserts no identity header. The
      // url_verification handshake carries no user and is answered by
      // the service directly. Unlinked (null) still constructs the
      // service so the user gets an explicit refusal — and can run the
      // `link` DM command — but nothing executes.
      const headerLogin = request.headers.get("x-user-login");
      const slackLinks = slackPrincipalLinkStoreFromEnv(ctx.env);
      let principal: ChannelPrincipal | null | undefined;
      if (body.type === "url_verification") {
        principal = undefined;
      } else if (headerLogin) {
        principal = {
          userLogin: headerLogin,
          authorizerDid: `did:user:slack:${body.event?.user || "unknown"}`,
          tier: "trade",
        };
      } else {
        principal = await resolvePrincipal(
          ctx.env,
          {
            channel: "slack",
            channelUserId: typeof body.event?.user === "string" ? body.event.user : "",
            channelScopeId: typeof body.team_id === "string" ? body.team_id : "",
            text: typeof body.event?.text === "string" ? body.event.text : "",
          },
          { slackLinks }
        );
      }
      const orm = ctx.getOrm();
      const slackService = new ETradeSlackTradingService(
        ctx.env,
        orm,
        sessionId,
        principal,
        slackLinks,
        await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? sessionId)
      );
      const result = await slackService.processSlackEvent(body);
      ctx.audit("trading.slack_event", "trading", { actionType: result.actionType, handled: result.handled });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack event" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Interactive Component Actions (Button Approvals)
  if (path.endsWith("/trading/slack/interaction") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: same link-store resolution as events — a
      // button click is an approval attempt and is gated on the
      // clicker's own linked principal inside the service.
      const slackLinks = slackPrincipalLinkStoreFromEnv(ctx.env);
      const principal = await resolvePrincipal(
        ctx.env,
        {
          channel: "slack",
          channelUserId: typeof body.user?.id === "string" ? body.user.id : "",
          channelScopeId: typeof body.team?.id === "string" ? body.team.id : typeof body.team_id === "string" ? body.team_id : "",
          text: "",
        },
        { slackLinks }
      );
      const orm = ctx.getOrm();
      const slackService = new ETradeSlackTradingService(
        ctx.env,
        orm,
        sessionId,
        principal,
        slackLinks,
        await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? sessionId)
      );
      const result = await slackService.processSlackInteraction(body);
      ctx.audit("trading.slack_interaction", "trading", { actionId: result.actionId, orderId: result.orderId, status: result.status });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack interaction" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Slash Commands (/trade, /quote, /options, /portfolio, /snap)
  if (path.endsWith("/trading/slack/command") && request.method === "POST") {
    try {
      const formData = await request.formData();
      // Issue #1262 Phase 2: commands run through the single Slack
      // service (processSlackCommand) with a resolved principal from
      // the command's team_id + user_id — the retired SlackAgent
      // handler ran NLQ under the DO instance id with no tier gates.
      const slackLinks = slackPrincipalLinkStoreFromEnv(ctx.env);
      const principal = await resolvePrincipal(
        ctx.env,
        {
          channel: "slack",
          channelUserId: typeof formData.get("user_id") === "string" ? (formData.get("user_id") as string) : "",
          channelScopeId: typeof formData.get("team_id") === "string" ? (formData.get("team_id") as string) : "",
          text: typeof formData.get("text") === "string" ? (formData.get("text") as string) : "",
        },
        { slackLinks }
      );
      const orm = ctx.getOrm();
      const slackService = new ETradeSlackTradingService(
        ctx.env,
        orm,
        sessionId,
        principal,
        slackLinks,
        await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? sessionId)
      );
      return slackService.processSlackCommand(formData);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slash command" }, { status: 500 });
    }
  }

  // Cloudflare Browser Agent: Transaction Snapshot Dispatch via Webhook
  if ((path.endsWith("/trading/browser/transaction-snap") || path.endsWith("/browser/transaction-snap")) && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const tx: TransactionSnapData = body.transaction || body;
      const browserAgent = new BrowserAgent(ctx.agentCtx, ctx.env);
      const result = await browserAgent.sendTransactionSnapToSlack(tx, {
        webhookUrl: body.webhookUrl || ctx.env.SLACK_WEBHOOK_URL,
        channel: body.channel,
        caption: body.caption,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate transaction snap" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Voice Trading Turn
  if (path.endsWith("/trading/voice/turn") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: voice adopts the ChannelIntake contract
      // type only — the principal is the session login (every entry to
      // this route is session-authenticated in server.ts), tier "trade",
      // behaviour unchanged.
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const principal =
        (await resolvePrincipal(ctx.env, { channel: "voice", channelUserId: userLogin, text: "" })) ?? undefined;
      const orm = ctx.getOrm();
      const voiceService = new ETradeVoiceTradingService(
        ctx.env,
        orm,
        userLogin,
        ctx.nlqSchedulingPort(),
        principal,
        await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? userLogin)
      );
      const result = await voiceService.processVoiceTurn({
        ...body,
        sessionId: userLogin,
        userLogin,
      });
      ctx.audit("trading.voice_turn", "trading", { actionType: result.actionType, orderId: result.orderId, success: result.success });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process voice turn" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Voice Trading Welcome Greeting
  if (path.endsWith("/trading/voice/greeting") && request.method === "GET") {
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const principal =
      (await resolvePrincipal(ctx.env, { channel: "voice", channelUserId: userLogin, text: "" })) ?? undefined;
    const orm = ctx.getOrm();
    const voiceService = new ETradeVoiceTradingService(
      ctx.env,
      orm,
      userLogin,
      undefined,
      principal,
      await buildChannelNlqDeps(ctx, orm, principal?.userLogin ?? userLogin)
    );
    return Response.json(voiceService.getWelcomeGreeting());
  }

  return null;
}

