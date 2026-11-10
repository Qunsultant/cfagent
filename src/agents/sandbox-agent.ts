/**
 * Issue #2253 — SandboxAgent: the container sandbox as a first-class
 * fleet member.
 *
 * What this class IS: a minimal PortThink Durable Object, bound as
 * SANDBOX_AGENT (wrangler migration v13), whose two doors — a status
 * surface and a run door — delegate to the ONE existing sandbox
 * implementation, ETradeSandboxService (src/services/sandboxAgent.ts).
 * The agent adds no sandbox logic of its own; there is exactly one
 * implementation, and when a backend is ever bound, only the
 * service's construction changes (the #2215 bindings-first posture:
 * registration landed first; the call-site wiring follow-up landed
 * in #2732 — the MCP command run_sandbox_command now resolves this
 * class on the SANDBOX_AGENT binding and calls runCommand, like the
 * A2A and HTTP doors).
 *
 * Degraded posture — read this before mistaking existence for
 * capability: NO container backend is bound. The service is
 * constructed with no container, exactly as the MCP facade
 * constructs it today, so the run door returns the service's honest
 * not-executed result (issue #121: executed:false, exitCode:null, an
 * explicit error). Shell execution is never emulated and output is
 * never fabricated — by this agent or by the service. The status
 * surface says the same thing in plain terms.
 *
 * The owner step that lifts the degradation: add a Cloudflare
 * Containers configuration for this class (a "containers" entry in
 * wrangler.jsonc naming SandboxAgent, with an owner-chosen image)
 * and construct ETradeSandboxService with the bound container
 * (this.ctx.container) instead of undefined. That is an
 * infrastructure decision (image, limits, network posture) — this
 * slice deliberately invents none of it.
 *
 * Chat-surface mapping (the #1959 idiom): this class defines NO
 * chat behavior — no model, no system prompt, no tool surface, and
 * its port hooks are deliberately unset, so PortThink handles a
 * turn the way it does for BrowserAgent/SlackAgent (beforeTurn
 * returns undefined, onChatResponse is a no-op, onChatError returns
 * the error). Giving it a model now would be new behavior, not
 * registration. Its doors are the domain methods below plus the
 * HTTP onRequest surface, mirroring BrowserAgent.
 *
 * OUT of scope (follow-up): the containers configuration itself
 * (owner step, above). The two call-site follow-ups recorded here
 * have landed: the A2A door/card in #2421 (Agent Mesh S15 —
 * handleA2A below, dispatch in ./sandboxA2aDispatch.ts, on the
 * shared A2A edge gate), and the run_sandbox_command rewiring in
 * #2732 (tracker #2708 A4) — the MCP command resolves this class on
 * the SANDBOX_AGENT binding (service instance "sandbox") and calls
 * runCommand; an environment without the binding answers in the
 * same honest shape from the command itself.
 */

import { PortThink } from "../actors/thinkAdapter";
import { ETradeSandboxService } from "../services/sandboxAgent";
import {
  dispatchSandboxA2A,
  sandboxA2AOutcome,
  type SandboxA2AOutcome,
} from "./sandboxA2aDispatch";
import type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "../types";

/**
 * The status surface's answer. `backendConfigured` is the whole
 * point: false means every run through this agent is a
 * non-execution, stated plainly rather than discovered from a
 * failed result.
 */
export interface SandboxAgentStatus {
  agent: "SandboxAgent";
  backendConfigured: boolean;
  degraded: boolean;
  detail: string;
}

const DEGRADED_DETAIL =
  "Degraded: no container backend is bound, so commands are NOT executed " +
  "(executed:false, exitCode:null). Shell execution is not emulated and no " +
  "output is fabricated. Enablement is an owner step: add a Cloudflare " +
  "Containers configuration for SandboxAgent in wrangler.jsonc (owner-chosen " +
  "image) and construct ETradeSandboxService with the bound container.";

/**
 * Issue #3934: this class hosts no chat turn, so the port's turn
 * hook never fires for it — the web_fetch / web_search
 * capabilities are composed on its execution surface instead
 * (PortThink.getExecutionTools, the same builder and the same
 * capability gate as the turn path), alongside the sandbox
 * capability this class exists for.
 */
export class SandboxAgent extends PortThink {
  private sandboxService?: ETradeSandboxService;

  private getService(): ETradeSandboxService {
    if (!this.sandboxService) {
      // In Cloudflare Containers environments, container is bound at this.ctx.container.
      // When available, pass it to the sandbox service; otherwise fallback to undefined.
      const container = (this.ctx as any)?.container;
      this.sandboxService = new ETradeSandboxService(container, this.env);
    }
    return this.sandboxService;
  }

  /**
   * Status surface: is a container backend configured? When a
   * container is bound at this.ctx.container, reports active and ready;
   * otherwise honestly reports degraded (issue #121).
   */
  sandboxStatus(): SandboxAgentStatus {
    const hasContainer = Boolean((this.ctx as any)?.container);
    if (hasContainer) {
      return {
        agent: "SandboxAgent",
        backendConfigured: true,
        degraded: false,
        detail:
          "Active: Cloudflare container backend is bound (cloudflare/debian-trixie) and ready for execution.",
      };
    }
    return {
      agent: "SandboxAgent",
      backendConfigured: false,
      degraded: true,
      detail: DEGRADED_DETAIL,
    };
  }

  /**
   * Run door: delegate to the one sandbox service and return its
   * result shape unchanged. With no backend bound that result is
   * the honest not-executed shape (#121) — this door adds no
   * execution, emulation, or output of its own.
   */
  async runCommand(
    request: SandboxExecutionRequest
  ): Promise<SandboxExecutionResult> {
    return this.getService().runCommand(request);
  }

  /**
   * Handles incoming HTTP requests dispatched to the Sandbox Agent
   * (the fleet's onRequest idiom, mirroring BrowserAgent): health/
   * status at / and /health, the run door at POST /run.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
        },
      });
    }

    // Health check / status surface
    if (path.endsWith("/health") || path === "/") {
      return Response.json({
        ...this.sandboxStatus(),
        status: "active",
        capabilities: ["sandbox_status", "run_command"],
        timestamp: new Date().toISOString(),
      });
    }

    // POST /run: run a command through the sandbox service. With
    // no backend bound the service's answer is the honest
    // not-executed result — returned unchanged, never dressed up.
    if (path.endsWith("/run") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        if (!body || typeof body.command !== "string" || body.command === "") {
          return Response.json(
            { error: "A command string is required." },
            { status: 400 }
          );
        }
        const result = await this.runCommand({
          command: body.command,
          timeoutMs: body.timeoutMs,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json(
          { success: false, error: err.message },
          { status: 500 }
        );
      }
    }

    return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
  }

  /**
   * Issue #2421 (Agent Mesh S15): A2A door, cfpay signature — the
   * edge dispatcher (src/a2a) resolves the "sandbox" name to this
   * class (stateless/env-driven, so the bare name is the instance,
   * browser parity) and calls this with the parsed body + origin
   * (a Request cannot cross the DO RPC boundary). Thin delegation
   * to the dispatch module (./sandboxA2aDispatch); results are the
   * service's own — in this deployment the honest not-executed
   * shape. The deliberately unset portHooks do not block this
   * door: it calls the real methods directly, never a turn.
   * Returns the collected { text, data } outcome.
   */
  async handleA2A(body: unknown, origin: string): Promise<SandboxA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchSandboxA2A(this.env, body, {
      executor: {
        sandboxStatus: () => this.sandboxStatus(),
        runCommand: (request) => this.runCommand(request),
      },
    });
    return sandboxA2AOutcome(data);
  }
}
