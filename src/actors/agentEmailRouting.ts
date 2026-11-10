/**
 * Issue #3490 (Uniform Copilot Standard S2, epic #3488) — the email
 * channel's Worker-side routing: which inbound mail is agent mail,
 * and which instance it belongs to.
 *
 * Address scheme (the SDK docs' address-based resolver pattern,
 * keyed to per-login instance naming): an agent instance is
 * addressed as `<agent-kebab>+<instance>@<domain>` — e.g.
 * `orchestrator-agent+alice@agent.openaimp.com` routes to the
 * OrchestratorAgent DO instance named `alice` (the per-login
 * instance name; server.ts resolves the same name with
 * `ORCHESTRATOR_AGENT.idFromName(userLogin)`). The `+` sub-address
 * IS the stable identifier: outbound agent mail is sent From that
 * address, so replies come back to it.
 *
 * The gate is deliberately narrow, and it runs BEFORE the SDK is
 * ever involved: only a `+` sub-address whose agent part resolves
 * to a Durable Object namespace present in env is agent mail. A
 * bare mailbox address (`trade@agent.openaimp.com`) has no agent
 * route and falls through to the existing NLQ handler untouched —
 * the NLQ pipeline (src/trading/email/agent.ts) never inspects
 * `to` itself, so this gate is the only thing standing between
 * agent mail and trade mail, and it errs toward NLQ.
 *
 * The resolver handed to the SDK's `routeAgentEmail` is the
 * composite from the Agents docs' email example: the secure-reply
 * leg first (HMAC-signed X-Agent-* headers, verified against
 * EMAIL_SECRET when configured — replies to outbound agent mail),
 * then the address leg. The address leg is this module's own
 * parse + namespace check, NOT the SDK's
 * `createAddressBasedEmailResolver`: the SDK factory maps a bare
 * local part to a default agent, which would route NLQ mail to an
 * agent if the resolver were ever called on it; this module's leg
 * requires the `+` form, so a bare address returns null even if
 * the gate is bypassed. The secure leg likewise only returns an
 * agent whose namespace exists in env; a signed header for an
 * unbound agent falls through to the address leg.
 *
 * `routeAgentEmail` itself is reached by DYNAMIC import, on
 * purpose: the bare "agents" entry cannot load under Node vitest
 * (its graph reaches `cloudflare:email`), and 133 suites mock it
 * — a static import here would make every one of those mocks
 * provide a name it does not. The dynamic import runs only after
 * the pure gate passes, so no existing test path ever triggers
 * it; in production (workerd) the real module provides it, and
 * when it does not, routing fails loud instead of misdelivering.
 */
import { createSecureReplyEmailResolver } from "agents/email";
import type { EmailResolver } from "agents/email";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "actors/agentEmailRouting",
});

/**
 * The SDK's address shape, mirrored exactly (agents 0.32.0,
 * dist/email.js createAddressBasedEmailResolver): a local part of
 * 1–64 chars, an optional `+` sub-address of 1–64 chars, a domain
 * of 1–253 chars. This module's parse REQUIRES the sub-address.
 */
const AGENT_EMAIL_ADDRESS_PATTERN = /^([^+@]{1,64})\+([^@]{1,64})@(.{1,253})$/;

/** The env half the routing needs — a record of bindings, nothing else. */
export type AgentEmailRoutingEnv = Record<string, unknown>;

/** An inbound worker email message, structurally (ForwardableEmailMessage). */
export interface AgentChannelEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  rawSize: number;
  raw?: unknown;
  reply?: unknown;
}

/** A parsed agent address: which agent binding, which instance. */
export interface ParsedAgentEmailAddress {
  agentName: string;
  agentId: string;
}

/**
 * Parse `<agent>+<instance>@<domain>` into its routing parts.
 * A bare mailbox address (no `+`) returns null — it is not agent
 * mail. Never throws.
 */
export function parseAgentEmailAddress(
  to: unknown,
): ParsedAgentEmailAddress | null {
  if (typeof to !== "string") return null;
  const match = to.match(AGENT_EMAIL_ADDRESS_PATTERN);
  if (!match) return null;
  return { agentName: match[1], agentId: match[2] };
}

/**
 * The SDK's camelCaseToKebabCase (agents 0.32.0, dist/utils.js),
 * mirrored so this module's namespace map agrees with
 * routeAgentEmail's own map exactly.
 */
export function agentNameToKebabCase(value: string): string {
  if (value === value.toUpperCase() && value !== value.toLowerCase()) {
    return value.toLowerCase().replace(/_/g, "-");
  }
  let kebabified = value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

/**
 * Resolve an agent name to its Durable Object namespace in env,
 * with the SDK routeAgentEmail's lookup (agents 0.32.0,
 * dist/src-DoGNJ4Ud.js routeAgentEmail): the env map over exact /
 * kebab-case / lowercase keys, over values carrying `idFromName`.
 * Returns undefined when no such namespace exists — the gate that
 * keeps unknown agent prefixes out of the agent channel.
 */
export function resolveAgentEmailNamespace(
  env: object | null | undefined,
  agentName: string,
): unknown {
  if (!env || typeof env !== "object") return undefined;
  // The map is built from the ENV keys (exact / kebab-case /
  // lowercase), exactly like the SDK's routeAgentEmail cache —
  // the lookup key is then the agent name as addressed.
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { idFromName?: unknown }).idFromName === "function"
    ) {
      if (
        key === agentName ||
        agentNameToKebabCase(key) === agentName ||
        key.toLowerCase() === agentName
      ) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * True exactly when this mail is agent mail: a `+` sub-address
 * whose agent part names a bound agent namespace. Everything else
 * — bare mailboxes, unknown agents, malformed addresses — is not.
 */
export function isAgentChannelEmail(to: unknown, env: object | null | undefined): boolean {
  const parsed = parseAgentEmailAddress(to);
  if (!parsed) return false;
  return resolveAgentEmailNamespace(env, parsed.agentName) !== undefined;
}

/**
 * The non-blank-string rule for the email secret, mirroring the
 * #3474 webhook-secret resolver: blank or non-string is
 * unconfigured, never a (broken) secret.
 */
export function resolveEmailSecret(env: object | null | undefined): string | undefined {
  const value = (env as Record<string, unknown> | null | undefined)?.EMAIL_SECRET;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export interface PortThinkEmailResolverOptions {
  /**
   * Called when a mail carrying agent-routing headers fails
   * signature verification (reason: missing_headers | expired |
   * invalid | malformed_timestamp). Logging only — verification
   * failure never routes, it falls through to the address leg.
   */
  onInvalidSignature?: (
    email: AgentChannelEmailMessage,
    reason: string,
  ) => void;
}

/**
 * The composite resolver handed to the SDK's routeAgentEmail (the
 * docs' example shape): secure-reply leg first when EMAIL_SECRET
 * is configured, then the address leg. Returns null when neither
 * leg routes — the SDK's onNoRoute path, never a throw.
 */
export function createPortThinkEmailResolver<Env extends object>(
  env: Env,
  options: PortThinkEmailResolverOptions = {},
): EmailResolver<Env> {
  const secret = resolveEmailSecret(env);
  const secureResolver = secret
    ? createSecureReplyEmailResolver<Env>(secret, {
        onInvalidSignature: (email, reason) =>
          options.onInvalidSignature?.(
            email as unknown as AgentChannelEmailMessage,
            reason,
          ),
      })
    : undefined;
  return (async (email, callEnv) => {
    const liveEnv = (callEnv ?? env) as Env;
    if (secureResolver) {
      const secured = await secureResolver(email, liveEnv);
      if (secured) {
        // A signed header for an agent with no namespace in this
        // deployment is not a route — fall through to the address
        // leg rather than letting routeAgentEmail throw on it.
        if (resolveAgentEmailNamespace(liveEnv, secured.agentName) !== undefined) {
          return secured;
        }
      }
    }
    const parsed = parseAgentEmailAddress(
      (email as unknown as AgentChannelEmailMessage).to,
    );
    if (!parsed) return null;
    if (resolveAgentEmailNamespace(liveEnv, parsed.agentName) === undefined) {
      return null;
    }
    return { agentName: parsed.agentName, agentId: parsed.agentId };
  }) as EmailResolver<Env>;
}

export interface RouteAgentEmailFn<Env extends object = Record<string, unknown>> {
  (
    email: AgentChannelEmailMessage,
    env: Env,
    options: {
      resolver: EmailResolver<Env>;
      onNoRoute?: (email: AgentChannelEmailMessage) => void | Promise<void>;
    },
  ): Promise<void>;
}

/**
 * Route one inbound worker email through the agent channel when it
 * is agent-addressed, and report whether it routed. Returns false
 * (without touching the SDK) for everything else — the caller
 * falls through to the existing NLQ handler.
 *
 * The SDK entry is dynamically imported (see the module header):
 * when the pinned SDK does not expose routeAgentEmail in the
 * running runtime, routing fails loud instead of misdelivering.
 * onNoRoute is unreachable through the gate above (the gate and
 * the resolver agree on the address leg) — if it ever fires, it
 * throws rather than dropping agent mail silently.
 */
export async function routeAgentChannelEmail<Env extends object>(
  message: AgentChannelEmailMessage,
  env: Env,
  routeFn?: RouteAgentEmailFn<Env>,
): Promise<boolean> {
  if (!isAgentChannelEmail(message?.to, env)) return false;
  const route =
    routeFn ??
    (
      (await import("agents")) as unknown as {
        routeAgentEmail?: RouteAgentEmailFn<Env>;
      }
    ).routeAgentEmail;
  if (typeof route !== "function") {
    throw new Error(
      "email_channel_routeAgentEmail_unavailable: the pinned agents SDK does not expose routeAgentEmail in this runtime (agents 0.32.0 exposes it under workerd) — refusing to route agent mail rather than misdelivering it (#3490)",
    );
  }
  await route(message, env, {
    resolver: createPortThinkEmailResolver(env),
    onNoRoute: async (email) => {
      structuredLog.warn("portthink.email_no_route", {
        message:
          "[PortThink] agent-addressed email passed the channel gate but the resolver found no route — refusing to drop it silently",
        to: email.to,
        from: email.from,
      });
      throw new Error(
        `email_channel_no_route: agent-addressed email to ${email.to} found no route (#3490)`,
      );
    },
  });
  return true;
}
