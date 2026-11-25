/**
 * Cloudflare Slack Trading Agent.
 *
 * This class keeps the Agents SDK surface (the export pin in
 * tests/dead-agent-classes.test.ts, the /health endpoint, the #147
 * signature gate, and the /transaction-snap trigger) and the two
 * delegation helpers external code calls (sendPreTradeApprovalTicket,
 * dispatchTransactionSnap). It no longer parses Slack payloads
 * itself: slash commands, events, and interactions all delegate to
 * the single service, ETradeSlackTradingService — the duplicate
 * handleSlashCommand / handleInteraction implementations were
 * retired in #1262 Phase 2 (they ran NLQ under the DO instance id
 * with no principal resolution or tier gates, and double-dispatched
 * transaction snaps after approvals).
 *
 * Issue #2412 (Agent Mesh S13, G10): Slack ingress is ONE
 * implementation. Production ingress runs src/server.ts routes →
 * OrchestratorAgent instances named slack_<teamId> →
 * handleTradingIntegrationsRoutes (src/agents/routes/
 * tradingIntegrations.ts) → the service. This class's onRequest
 * previously carried a parallel ingress (its own principal
 * resolution and a service construction with NO NLQ dep set, so
 * behavior differed by entry point); it now delegates the same
 * three payload shapes to the same handler with an agent-hosted
 * route context (tradingRouteContext below), so the gate, the
 * principal resolution, the NLQ dep set, the event dedup, and the
 * service are identical on both hosts. The production host stays
 * the orchestrator instance because the channel's NLQ dep set is
 * host-bound: the scheduling port binds the host class's own
 * schedule-callback methods (which exist only on
 * OrchestratorAgent), the discovery stores are built over the host
 * instance's storage, and the approval draft ledger lives in the
 * host instance's ORM. On THIS host the scheduling port therefore
 * refuses honestly (see refusingNlqSchedulingPort) rather than
 * registering schedules whose callbacks this class cannot run.
 * The SLACK_AGENT DO binding exists since #2215; the class's first
 * production instantiation is its A2A door — handleA2A below,
 * #2223 — and chat reaches its outbound helpers through the G1
 * door (#2351).
 *
 * Issue #1960 (think-fleet): migrated from AIChatAgent to PortThink
 * (src/actors/thinkAdapter.ts). Chat-surface mapping, verified from
 * this file and its tests: the class defines no onChatMessage /
 * onChatResponse / onChatError / getModel / getSystemPrompt / getTools
 * and drives no AI chat turn — its "chat" is Slack webhook ingress
 * (commands, interactions, events) in onRequest below, delegating to
 * ETradeSlackTradingService, plus the two domain helpers. AIChatAgent's
 * WS chat-request path therefore only ever reached its default
 * onChatMessage, which throws; Think's native WS chat (runTurn with
 * Think defaults) replaces that throwing stub. The get-messages
 * onRequest intercept maps too: AIChatAgent returned its stored
 * transcript JSON, Think returns Response.json(this.messages) — and
 * this class writes to neither store, so both are empty in practice.
 * No port hooks object exists to keep (none were defined) and no
 * adapter turn is wired: inventing a model/tools/prompt would be new
 * behavior, not a preserved turn path. PortThink.portHooks stays
 * unset, so a direct Think turn uses Think defaults.
 */

import { PortThink } from "../actors/thinkAdapter";
import {
  dispatchSlackA2A,
  slackA2AOutcome,
  type SlackA2AOutcome,
} from "./slackA2aDispatch";
import type {
  TransactionSnapData,
  PreTradeApprovalDraft,
} from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "./did";
import {
  ETradeSlackTradingService,
  verifySlackSignature,
} from "../trading";
import { gateSlackRequest } from "../security/webhookSecurity";
import { BrowserAgent } from "./browserAgent";
import {
  handleTradingIntegrationsRoutes,
  type TradingIntegrationsRouteContext,
} from "./routes/tradingIntegrations";
import type { NLQSchedulingPort } from "./nlq/types";
import { auditEventPort } from "../data/createAuditEventPorts";
import type { AgentName, AuditEvent } from "../types";

export class SlackAgent extends PortThink {
  private slackService?: ETradeSlackTradingService;
  private browserAgent?: BrowserAgent;

  /**
   * Issue #2412 (Agent Mesh S13, G10): fail closed. This used to
   * fall back to a synthetic "master" session literal when the
   * instance id was absent — exactly the synthetic-identity shape
   * the mesh programme retires (S3 deferred the site to this
   * slice). A real Durable Object instantiation always carries
   * ctx.id; its absence means the class was constructed outside a
   * DO runtime, where inventing a shared session identity would
   * attribute work to nobody. Refuse instead.
   */
  sessionKey(): string {
    if (!this.ctx?.id) {
      throw new Error(
        "SlackAgent has no Durable Object instance id — refusing to invent a session identity"
      );
    }
    return this.ctx.id.toString();
  }

  private getSlackService(orm?: DatabaseORM): ETradeSlackTradingService {
    if (!this.slackService) {
      this.slackService = new ETradeSlackTradingService(
        this.env,
        orm,
        this.sessionKey()
      );
    } else if (orm && (this.slackService as any).orm !== orm) {
      (this.slackService as any).orm = orm;
    }
    return this.slackService;
  }

  private getBrowserAgent(): BrowserAgent {
    if (!this.browserAgent) {
      this.browserAgent = new BrowserAgent(this.ctx, this.env);
    }
    return this.browserAgent;
  }

  private getOrm(): DatabaseORM {
    // No schema-initialization call here by design: the #2345 R-7
    // composition pin reserves schema initialization to the
    // designated initializer classes; this class's ORM runs over
    // the shared schema the store's initializer ensured (an
    // uninitialized store fails loud at the service's requireOrm,
    // #781).
    return new DatabaseORM(this.ctx.storage.sql);
  }

  /**
   * Audit writer for the agent-hosted route context: the same
   * mas_events row shape OrchestratorAgent.recordAudit writes
   * (issue #270's single-owner insert, replicated at this host),
   * with the same never-fail-the-request discipline as
   * OrchestratorAgent.audit.
   */
  private audit(type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>): void {
    // #6102: the row writes to D1 now. This host's audit seam is
    // sync and best-effort — the D1 write fire-and-forgets and can
    // never fail or block the request (orchestrator parity).
    void (async () => {
      try {
        const port = await auditEventPort(
          this.env as unknown as { AGENT_DB?: unknown },
        );
        if (!port) return;
        await port.create({
          id: crypto.randomUUID(),
          sessionId: this.sessionKey(),
          type,
          agent: agent as AuditEvent["agent"],
          payload,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Don't fail execution if audit insertion fails (orchestrator parity).
      }
    })();
  }

  /**
   * Issue #2412: on the SlackAgent host there is no schedule
   * registry this class can fire — NLQ schedule callbacks are
   * methods on OrchestratorAgent, the host that owns the channel
   * ledger in production. Binding this class's own Agent-base
   * scheduling API would register schedules whose callbacks do not
   * exist here and strand them silently; refusing makes the NLQ
   * executor report the failure honestly, exactly as a missing
   * port did before S13.
   */
  private refusingNlqSchedulingPort(): NLQSchedulingPort {
    const refuse = (): never => {
      throw new Error(
        "NLQ scheduling is unavailable on the SlackAgent host — schedules are hosted by the orchestrator instance that owns the channel ledger"
      );
    };
    return {
      schedule: refuse,
      scheduleEvery: refuse,
      cancelSchedule: refuse,
      listSchedules: refuse,
    } as unknown as NLQSchedulingPort;
  }

  /**
   * Issue #2412: the route context the shared channel handler
   * (src/agents/routes/tradingIntegrations.ts) runs against when
   * THIS class hosts it — the same handler the production
   * server.ts forwards reach on OrchestratorAgent instances.
   */
  private tradingRouteContext(): TradingIntegrationsRouteContext {
    return {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      agentCtx: this.ctx,
      nlqSchedulingPort: () => this.refusingNlqSchedulingPort(),
      getStorageSql: () => this.ctx.storage.sql,
    };
  }

  /**
   * Dispatches a Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
   * Before executing any trade, a message must be sent to Slack and approved.
   */
  async sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string; webhookUrl?: string } = {}
  ) {
    const service = this.getSlackService(this.getOrm());
    return service.sendPreTradeApprovalTicket(draft, options);
  }

  /**
   * Dispatches a transaction snapshot to Slack by coordinating with the Browser Agent
   */
  async dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { webhookUrl?: string; channel?: string; caption?: string } = {}
  ) {
    const browser = this.getBrowserAgent();
    return browser.sendTransactionSnapToSlack(tx, {
      webhookUrl: options.webhookUrl || this.env.SLACK_WEBHOOK_URL,
      channel: options.channel,
      caption: options.caption,
    });
  }

  /**
   * Issue #2223 (final slice): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the "slack" name to this class
   * and calls this with the parsed body + origin (a Request cannot
   * cross the DO RPC boundary). Thin delegation to the dispatch
   * module (./slackA2aDispatch), which serves ONLY the two domain
   * helpers above — the Slack ingress in onRequest below is
   * HTTP-form shaped, carries its own signature gate, and is not
   * an A2A surface; the server-route ingress is unchanged. This
   * door is the class's first production instantiation as a Durable
   * Object. Returns the collected { text, data } outcome.
   */
  async handleA2A(body: unknown, origin: string): Promise<SlackA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchSlackA2A(this.env, body, {
      executor: {
        sendPreTradeApprovalTicket: (draft, options) => this.sendPreTradeApprovalTicket(draft, options),
        dispatchTransactionSnap: (tx, options) => this.dispatchTransactionSnap(tx, options),
      },
    });
    return slackA2AOutcome(data);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-slack-signature, x-slack-request-timestamp",
        },
      });
    }

    // Health check
    if (path.endsWith("/health") || path === "/") {
      return Response.json({
        agent: "SlackAgent",
        status: "active",
        did: AGENT_DIDS.TRADING || "did:agent:openaimp:trading",
        capabilities: ["events_api", "slash_commands", "interactive_buttons", "browser_agent_snaps"],
        timestamp: new Date().toISOString(),
      });
    }

    // Issue #147: Slack signature verification is MANDATORY on the
    // Slack ingress paths — the same gate the worker routes in
    // src/server.ts apply (defense in depth: this agent is also
    // reachable via Agents SDK routing, and the gate must hold at
    // every layer a Slack payload can enter). Unconfigured → honest
    // 503 before any processing; configured → a missing or invalid
    // signature is rejected 401. Previously the check ran only when a
    // secret was configured AND the caller presented signature
    // headers, so unsigned requests were processed in every
    // configuration.
    const isSlackIngress =
      path.endsWith("/commands") || path.endsWith("/slash") ||
      path.endsWith("/interactions") ||
      path.endsWith("/events") || path.endsWith("/slack");
    // Issue #2412: the gate's verified raw body is what the shared
    // handler consumes below — the payload is read exactly once,
    // from the bytes the signature was verified over.
    let gateRawBody: string | null = null;
    if (request.method === "POST" && isSlackIngress) {
      const gate = await gateSlackRequest(request.clone(), this.env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      gateRawBody = gate.rawBody;
    } else if (request.method === "POST" && this.env.SLACK_SIGNING_SECRET) {
      // Non-Slack POSTs (e.g. the manual /transaction-snap trigger):
      // unchanged behaviour — when the caller presents Slack signature
      // headers, a bad signature is still rejected.
      const ts = request.headers.get("x-slack-request-timestamp");
      const sig = request.headers.get("x-slack-signature");
      if (ts && sig) {
        const rawBody = await request.clone().text();
        const isValid = await verifySlackSignature(this.env.SLACK_SIGNING_SECRET, ts, rawBody, sig);
        if (!isValid) {
          return new Response("Invalid Slack signature", { status: 401 });
        }
      }
    }

    // Issue #2412 (Agent Mesh S13, G10): Slack ingress delegates to
    // the SHARED channel handler — the same
    // handleTradingIntegrationsRoutes the production server.ts
    // forwards terminate in on OrchestratorAgent instances. The
    // per-path blocks that used to live here (own principal
    // resolution, own service construction with NO NLQ dep set)
    // were the parallel implementation G10 retires: behavior now
    // cannot differ by entry point. The delegated request is built
    // from the gate's verified raw body, carries only the content
    // type the handler's branch expects, and never forwards an
    // x-user-login header — that session-principal assertion is
    // the server.ts simulator's to make on its own forward, and
    // this host has no session forwarder.
    if (request.method === "POST" && isSlackIngress) {
      const rawBody = gateRawBody;
      if (rawBody === null) {
        // The gate above ran on the non-ingress branch (defensive:
        // isSlackIngress and the gate branch use the same path set).
        return Response.json({ error: "Slack ingress gate did not verify a body" }, { status: 500 });
      }
      let targetPath: string;
      let contentType: string;
      let body: string;
      if (path.endsWith("/commands") || path.endsWith("/slash")) {
        targetPath = "/trading/slack/command";
        contentType = "application/x-www-form-urlencoded";
        body = rawBody;
      } else if (path.endsWith("/interactions")) {
        const payloadRaw = new URLSearchParams(rawBody).get("payload");
        if (!payloadRaw) return new Response("Missing payload parameter", { status: 400 });
        targetPath = "/trading/slack/interaction";
        contentType = "application/json";
        body = payloadRaw;
      } else {
        targetPath = "/trading/slack/event";
        contentType = "application/json";
        body = rawBody;
      }
      const delegated = new Request(`https://agent.internal${targetPath}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
      });
      const handled = await handleTradingIntegrationsRoutes(
        delegated,
        new URL(delegated.url),
        targetPath,
        this.sessionKey(),
        this.tradingRouteContext()
      );
      if (handled) return handled;
      return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
    }

    // 4. Manual Transaction Snap Trigger (/transaction-snap)
    if (path.endsWith("/transaction-snap") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        const result = await this.dispatchTransactionSnap(tx, {
          webhookUrl: body.webhookUrl,
          channel: body.channel,
          caption: body.caption,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
  }
}
