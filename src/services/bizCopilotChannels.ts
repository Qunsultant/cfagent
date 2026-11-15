/**
 * Issue #4517 (BizCopilot slice 3, umbrella #4514) — delivery-channel
 * enablement through the BizCopilot chat tab, extending the slice-1
 * tenant branch (src/services/bizCopilotTenants.ts) and the slice-2
 * account branch (src/services/bizCopilotAccounts.ts) with the same
 * deterministic shape: the turn's BizCopilot branch parses the
 * user's text for the channel activities (view enablement /
 * enable / disable / view enforcement state) and executes them by
 * calling the SAME server path the Channels page uses —
 * handlePlatformChannelRoutes in-process, with the same
 * store-operator gate, session-scoped identity, and audit as the
 * page path. No second implementation, no new server capability,
 * no change to the Channels page.
 *
 * The branch runs in OrchestratorAgent.portBeforeTurn (the
 * auto-options-research branch's shape): the deterministic result
 * is injected into the system prompt as retrieved content and the
 * model only narrates it (activeTools: []), exactly as the
 * auto-research job context is narrated.
 *
 * BOUNDED WAIT (#4513): the chat channel path never fetches. The
 * executor calls the route handler in-process against the D1
 * ports — a fixed small number of store calls, the same calls the
 * page path makes (one read, or one patch), no polling, no
 * retries, no unbounded loop. A failure anywhere surfaces as an
 * explicit BIZCOPILOT_CHANNEL_ERROR outcome, never a silent spin.
 *
 * HONEST CONFIGURATION-ONLY FLAGS (#3178): Copilot card and Docs
 * have no push dispatch funnel — no dispatch site consults those
 * flags, so enabling or disabling one sends nothing. The branch
 * never fakes a dispatch: every result carries the enforcement
 * state derived from the gate's own primitives
 * (channelGateFromConfig / mapScreeningChannelToTenantChannel /
 * channelDisabledError), which states plainly, per channel,
 * whether dispatch is permitted, refused (never attempted), or
 * configuration-only. Building the Copilot/Docs dispatch funnels
 * is #3178's decision, not this slice's. The narration
 * instruction in chatPrompt repeats the configuration-only truth
 * for Copilot card / Docs results.
 *
 * CONSERVATIVE PARSING: only explicit commands parse. A
 * recognizable-but-incomplete command — the command shape with
 * its tenant id missing (#4701) — parses to a deterministic
 * needs-identifier outcome: the turn answers asking for the
 * missing id, with the Channels page link. No route call is made
 * and no mutation is ever guessed. Anything ambiguous or
 * unrecognized returns null and the turn proceeds as a normal
 * LLM turn. An unknown channel name parses to nothing, never to
 * a guessed channel.
 *
 * RSI posture (slice 1): BizCopilot turns already flow through the
 * generic evaluation path (judge.evaluate + VectorMemory in
 * portOnChatResponse) and the turn audit records every executed
 * action (bizcopilot.channel_action_executed/failed). Behavior
 * changes only through governed adoption (code change + CI),
 * never silently — the governed RSI loop's observation step is
 * the audit trail, and adoption is a PR.
 */

import { handlePlatformChannelRoutes } from "../agents/routes/platformChannels";
import { isTenantIdShaped } from "../agents/routes/platformTenants";
import type { StoreOperators } from "../data/storeOperatorsPorts";
import type { TenantDirectory } from "../data/tenantDirectoryPorts";
import {
  TENANT_CHANNEL_IDS,
  type TenantChannelConfig,
  type TenantChannelId,
  type TenantChannelStore,
} from "../data/tenantChannelPorts";
import { BIZCOPILOT_REGISTRATION_ID } from "./bizCopilotTenants";
import { copilotRegistrationForSourceTab } from "./copilotChannels";
import {
  channelDisabledError,
  channelGateFromConfig,
  mapScreeningChannelToTenantChannel,
} from "./tenantChannelGate";

/** The Channels page every BizCopilot channel result links, so the user can open and verify what was done. */
export const BIZCOPILOT_CHANNELS_PAGE_URL =
  "https://agent.openaimp.com/?tab=platform-admin&view=channels";

/**
 * Display labels for the five channels, mirroring the Channels
 * panel's TENANT_CHANNEL_META (src/client/channelAdminApi.ts) —
 * the panel's copy is the display source of truth; this map
 * exists so the narration payload can name "Copilot card"
 * instead of the bare "copilot" id. Keep the two in sync.
 */
export const BIZCOPILOT_CHANNEL_LABELS: Record<TenantChannelId, string> = {
  email: "Email",
  slack: "Slack",
  webhook: "Webhook",
  copilot: "Copilot card",
  docs: "Docs",
};

/** The command shape a needs-identifier outcome recognized: the action the user asked for, minus its tenant id. */
export type BizCopilotChannelAskCommand = "show" | "enforcement" | "enable" | "disable";

export type BizCopilotChannelIntent =
  | { action: "show"; tenantId: string }
  | { action: "enforcement"; tenantId: string; channel?: TenantChannelId }
  | { action: "enable"; tenantId: string; channel: TenantChannelId }
  | { action: "disable"; tenantId: string; channel: TenantChannelId }
  | {
      action: "needs-identifier";
      command: BizCopilotChannelAskCommand;
      tenantId: null;
      /** For channel-specific asks: the channel the user named, so the ask names it. */
      channel?: TenantChannelId;
    };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
}

/** Map a user-named channel to its id, or null for anything unrecognized — never a guess. */
export function channelFromName(name: string): TenantChannelId | null {
  const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "email") return "email";
  if (normalized === "slack") return "slack";
  if (normalized === "webhook") return "webhook";
  if (normalized === "copilot" || normalized === "copilot card") return "copilot";
  if (normalized === "docs") return "docs";
  return null;
}

const CHANNEL_NAME_PATTERN = "(email|slack|webhook|copilot(?: card)?|docs)";

/**
 * Parse one channel command. Returns null for anything that is not
 * an explicit channel command — the turn then proceeds normally.
 * A recognizable command shape with its tenant id missing
 * returns a needs-identifier intent instead of null (#4701): the
 * turn then answers asking for the id, never falling through to
 * a model that denies the capability exists.
 */
export function parseBizCopilotChannelIntent(text: string): BizCopilotChannelIntent | null {
  const raw = normalize(text);
  if (!raw) return null;

  // Enable / disable: "enable email for tenant acme", "turn off
  // slack for acme", "set webhook off for tenant acme".
  const toggle = new RegExp(
    `^(enable|disable|turn on|turn off|switch on|switch off) ${CHANNEL_NAME_PATTERN}(?: channel)?(?: for)? (?:tenant )?(\\S+)$`,
    "i",
  ).exec(raw);
  if (toggle) {
    const tenantId = toggle[3];
    const channel = channelFromName(toggle[2]);
    if (!channel || !isTenantIdShaped(tenantId)) return null;
    const verb = toggle[1].toLowerCase();
    const enabled = verb === "enable" || verb === "turn on" || verb === "switch on";
    return { action: enabled ? "enable" : "disable", tenantId, channel };
  }
  const setToggle = new RegExp(
    `^set ${CHANNEL_NAME_PATTERN}(?: channel)? (on|off)(?: for)? (?:tenant )?(\\S+)$`,
    "i",
  ).exec(raw);
  if (setToggle) {
    const tenantId = setToggle[3];
    const channel = channelFromName(setToggle[1]);
    if (!channel || !isTenantIdShaped(tenantId)) return null;
    return {
      action: setToggle[2].toLowerCase() === "on" ? "enable" : "disable",
      tenantId,
      channel,
    };
  }

  // Enforcement, single channel: "is email enabled for tenant
  // acme" — a question about the actual state, answered from the
  // read config, never an assertion.
  const enforcementOne = new RegExp(
    `^is ${CHANNEL_NAME_PATTERN}(?: channel)? (enabled|disabled|on|off)(?: for| of)? (?:tenant )?(\\S+)$`,
    "i",
  ).exec(raw);
  if (enforcementOne) {
    const tenantId = enforcementOne[3];
    const channel = channelFromName(enforcementOne[1]);
    if (!channel || !isTenantIdShaped(tenantId)) return null;
    return { action: "enforcement", tenantId, channel };
  }

  // Enforcement, whole tenant: "show enforcement for tenant
  // acme", "what is the enforcement state for acme".
  const enforcement =
    /^(?:show|display|get)(?: me)? (?:the )?enforcement(?: state)?(?: for| of)? (?:tenant )?(\S+)$/i.exec(raw) ??
    /^what is (?:the )?enforcement(?: state)?(?: for| of)? (?:tenant )?(\S+)$/i.exec(raw);
  if (enforcement) {
    const tenantId = enforcement[1];
    if (!isTenantIdShaped(tenantId)) return null;
    return { action: "enforcement", tenantId };
  }

  // Enablement read: "show channels for tenant acme", "show
  // channel enablement for acme", "what channels are enabled for
  // tenant acme".
  const show =
    /^(?:show|display|get|list)(?: me)? (?:the )?(?:channel enablement|channels|channel settings)(?: for| of)? (?:tenant )?(\S+)$/i.exec(raw) ??
    /^what channels are (?:enabled|on)(?: for| of)? (?:tenant )?(\S+)$/i.exec(raw);
  if (show) {
    const tenantId = show[1];
    if (!isTenantIdShaped(tenantId)) return null;
    return { action: "show", tenantId };
  }

  // Needs-identifier asks (#4701): the command shapes above with
  // the tenant id missing. These run AFTER the complete shapes so
  // a complete command always wins; each returns the deterministic
  // ask outcome, never a route call. A trailing "for" / "for
  // tenant" / "of tenant" tail is accepted — the id is still
  // missing, so the ask is the same.
  const toggleAsk = new RegExp(
    `^(enable|disable|turn on|turn off|switch on|switch off) ${CHANNEL_NAME_PATTERN}(?: channel)?(?: for(?: tenant)?)?$`,
    "i",
  ).exec(raw);
  if (toggleAsk) {
    const channel = channelFromName(toggleAsk[2]);
    if (!channel) return null;
    const verb = toggleAsk[1].toLowerCase();
    const enabled = verb === "enable" || verb === "turn on" || verb === "switch on";
    return { action: "needs-identifier", command: enabled ? "enable" : "disable", tenantId: null, channel };
  }
  const setToggleAsk = new RegExp(
    `^set ${CHANNEL_NAME_PATTERN}(?: channel)? (on|off)(?: for(?: tenant)?)?$`,
    "i",
  ).exec(raw);
  if (setToggleAsk) {
    const channel = channelFromName(setToggleAsk[1]);
    if (!channel) return null;
    return {
      action: "needs-identifier",
      command: setToggleAsk[2].toLowerCase() === "on" ? "enable" : "disable",
      tenantId: null,
      channel,
    };
  }

  const enforcementOneAsk = new RegExp(
    `^is ${CHANNEL_NAME_PATTERN}(?: channel)? (enabled|disabled|on|off)(?: for| of)?(?: tenant)?$`,
    "i",
  ).exec(raw);
  if (enforcementOneAsk) {
    const channel = channelFromName(enforcementOneAsk[1]);
    if (!channel) return null;
    return { action: "needs-identifier", command: "enforcement", tenantId: null, channel };
  }

  if (
    /^(?:show|display|get)(?: me)? (?:the )?enforcement(?: state)?(?: for| of)?(?: tenant)?$/i.test(raw) ||
    /^what is (?:the )?enforcement(?: state)?(?: for| of)?(?: tenant)?$/i.test(raw)
  ) {
    return { action: "needs-identifier", command: "enforcement", tenantId: null };
  }

  if (
    /^(?:show|display|get|list)(?: me)? (?:the )?(?:channel enablement|channels|channel settings)(?: for| of)?(?: tenant)?$/i.test(raw) ||
    /^what channels are (?:enabled|on)(?: for| of)?(?: tenant)?$/i.test(raw)
  ) {
    return { action: "needs-identifier", command: "show", tenantId: null };
  }

  return null;
}

/** One channel's enforcement state: the flag, plus what dispatch does for it today. */
export interface BizCopilotChannelEnforcement {
  channel: TenantChannelId;
  label: string;
  enabled: boolean;
  /** permitted: a push funnel may dispatch. refused: an explicit disable refuses dispatch, sender never attempted. configuration-only: no push funnel exists, so the flag sends nothing either way. */
  dispatch: "permitted" | "refused" | "configuration-only";
  /** Plain-language enforcement state for the narration. */
  state: string;
}

/**
 * Derive the enforcement state from an already-read config,
 * using the gate's own primitives — the same vocabulary the
 * dispatch funnels refuse with. No dispatch is attempted here;
 * this only reports what dispatch would do.
 */
export function describeChannelEnforcement(
  tenantId: string,
  config: TenantChannelConfig,
): BizCopilotChannelEnforcement[] {
  const gate = channelGateFromConfig(tenantId, config);
  return TENANT_CHANNEL_IDS.map((channel) => {
    const label = BIZCOPILOT_CHANNEL_LABELS[channel];
    const enabled = gate.isEnabled(channel);
    if (mapScreeningChannelToTenantChannel(channel) === null) {
      // Copilot card / Docs: no push funnel dispatches them
      // (#3178 owns that decision) — configuration only, in
      // either flag state, stated plainly, never a dispatch.
      return {
        channel,
        label,
        enabled,
        dispatch: "configuration-only" as const,
        state: `${label} is configuration only — no dispatch exists for it yet, so this flag sends nothing.`,
      };
    }
    if (!enabled) {
      return {
        channel,
        label,
        enabled,
        dispatch: "refused" as const,
        state: `${channelDisabledError(channel, tenantId)} The sender is never attempted.`,
      };
    }
    return {
      channel,
      label,
      enabled,
      dispatch: "permitted" as const,
      state: `${label} is enabled — dispatch may proceed.`,
    };
  });
}

interface BizCopilotChannelExecutorDeps {
  /** Worker env (carries the AGENT_DB binding) — the same env the HTTP dispatch passes. */
  env: { AGENT_DB?: unknown };
  /** The turn's verified login (from the session, never client-supplied) — the operator identity the route gates on. */
  userLogin: string;
  /** Test seams: the route handler composes the adapters from env when these are absent, exactly as the HTTP dispatch does. */
  channels?: TenantChannelStore | null;
  directory?: TenantDirectory | null;
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

type ChannelRouteResult = { ok: boolean; status: number; body: Record<string, unknown> };

async function callChannelRoute(
  method: string,
  suffix: string,
  body: Record<string, unknown> | undefined,
  deps: BizCopilotChannelExecutorDeps,
): Promise<ChannelRouteResult> {
  const url = new URL(`https://bizcopilot.internal/platform-channels${suffix}`);
  const request = new Request(url.toString(), {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-login": deps.userLogin,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handlePlatformChannelRoutes(request, url, url.pathname, "bizcopilot-chat", {
    env: deps.env,
    channels: deps.channels,
    directory: deps.directory,
    operators: deps.operators,
  });
  if (!response) {
    return { ok: false, status: 500, body: { error: "Channel administration did not match a route." } };
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, body: parsed ?? {} };
}

function resultContext(
  intent: Exclude<BizCopilotChannelIntent, { action: "needs-identifier" }>,
  result: ChannelRouteResult,
): string {
  const base = {
    action: intent.action,
    tenantId: intent.tenantId,
    ...("channel" in intent && intent.channel ? { channel: intent.channel } : {}),
    pageUrl: BIZCOPILOT_CHANNELS_PAGE_URL,
  };
  if (!result.ok) {
    return `BIZCOPILOT_CHANNEL_ERROR: ${JSON.stringify({ ...base, status: result.status, error: result.body })}`;
  }
  const config = result.body["channels"] as TenantChannelConfig | undefined;
  const enforcement =
    config && typeof config === "object"
      ? describeChannelEnforcement(intent.tenantId, config)
      : undefined;
  return `BIZCOPILOT_CHANNEL_RESULT: ${JSON.stringify({
    ...base,
    result: { ...result.body, ...(enforcement ? { enforcement } : {}) },
  })}`;
}

/**
 * The ask message for a needs-identifier intent: the question the
 * turn answers with, naming the recognized command and showing a
 * complete example the parser accepts. No route call is made.
 */
function channelAskMessage(
  intent: Extract<BizCopilotChannelIntent, { action: "needs-identifier" }>,
): string {
  switch (intent.command) {
    case "show":
      return "Show the channels for which tenant? Name the tenant id — for example: Show channels for tenant acme.";
    case "enforcement":
      return intent.channel
        ? `Is ${BIZCOPILOT_CHANNEL_LABELS[intent.channel]} enabled for which tenant? Name the tenant id — for example: Is ${intent.channel} enabled for tenant acme?`
        : "Show the enforcement state for which tenant? Name the tenant id — for example: Show enforcement for tenant acme.";
    case "enable":
      if (!intent.channel) {
        return "Enable which channel for which tenant? Name the channel and the tenant id — for example: Enable email for tenant acme.";
      }
      return `Enable ${BIZCOPILOT_CHANNEL_LABELS[intent.channel]} for which tenant? Name the tenant id — for example: Enable ${intent.channel} for tenant acme.`;
    case "disable":
      if (!intent.channel) {
        return "Disable which channel for which tenant? Name the channel and the tenant id — for example: Disable slack for tenant acme.";
      }
      return `Disable ${BIZCOPILOT_CHANNEL_LABELS[intent.channel]} for which tenant? Name the tenant id — for example: Disable ${intent.channel} for tenant acme.`;
  }
}

/**
 * Execute a parsed channel intent through the Channels page's own
 * routes, in-process. Returns the deterministic context block the
 * turn injects into the system prompt — success or failure, always
 * with the Channels page link and the enforcement state. Throws
 * only on an unexpected transport failure inside the handler;
 * route-level failures (401/403/404/400) are outcomes, returned
 * as ERROR context.
 */
export async function executeBizCopilotChannelIntent(
  intent: BizCopilotChannelIntent,
  deps: BizCopilotChannelExecutorDeps,
): Promise<string> {
  if (!deps.userLogin) {
    return `BIZCOPILOT_CHANNEL_ERROR: ${JSON.stringify({
      action: intent.action,
      tenantId: intent.tenantId,
      ...("channel" in intent && intent.channel ? { channel: intent.channel } : {}),
      pageUrl: BIZCOPILOT_CHANNELS_PAGE_URL,
      status: 401,
      error: { error: "Unauthorized: a signed-in session is required." },
    })}`;
  }

  if (intent.action === "show" || intent.action === "enforcement") {
    return resultContext(
      intent,
      await callChannelRoute("GET", `/${encodeURIComponent(intent.tenantId)}`, undefined, deps),
    );
  }

  if (intent.action === "needs-identifier") {
    return `BIZCOPILOT_CHANNEL_RESULT: ${JSON.stringify({
      action: intent.action,
      command: intent.command,
      tenantId: null,
      ...(intent.channel ? { channel: intent.channel } : {}),
      needsIdentifier: true,
      ask: channelAskMessage(intent),
      pageUrl: BIZCOPILOT_CHANNELS_PAGE_URL,
    })}`;
  }

  // enable / disable: one PATCH with the single named flag — the
  // same partial patch the Channels page sends. For Copilot card /
  // Docs the flag change is itself legitimate (the page allows
  // it); the result's enforcement state states plainly that the
  // flag is configuration-only and no dispatch exists.
  return resultContext(
    intent,
    await callChannelRoute(
      "PATCH",
      `/${encodeURIComponent(intent.tenantId)}/channels`,
      { channels: { [intent.channel]: intent.action === "enable" } },
      deps,
    ),
  );
}

/**
 * The BizCopilot turn branch (called from
 * OrchestratorAgent.portBeforeTurn): on a BizCopilot turn whose
 * text parses as an explicit channel command, execute it
 * deterministically through the Channels page's own routes and
 * return the outcome context for the system prompt. Returns ""
 * when the turn is not a BizCopilot channel command — the turn
 * then proceeds normally. Route-level failures are outcomes in
 * the returned context, never thrown; only an unexpected
 * transport failure inside the handler throws, and the caller
 * turns it into an ERROR context.
 */
export async function runBizCopilotChannelBranch(deps: {
  sourceTab?: string;
  userText: string;
  env: { AGENT_DB?: unknown };
  userLogin: string;
  audit: (type: string, payload: Record<string, unknown>) => void;
  /** Test seams: the route handler composes the adapters from env when these are absent, exactly as the HTTP dispatch does. */
  channels?: TenantChannelStore | null;
  directory?: TenantDirectory | null;
  operators?: Pick<StoreOperators, "listOperators"> | null;
}): Promise<string> {
  if (copilotRegistrationForSourceTab(deps.sourceTab) !== BIZCOPILOT_REGISTRATION_ID) return "";
  const intent = parseBizCopilotChannelIntent(deps.userText);
  if (!intent) return "";
  try {
    const context = await executeBizCopilotChannelIntent(intent, {
      env: deps.env,
      userLogin: deps.userLogin,
      channels: deps.channels,
      directory: deps.directory,
      operators: deps.operators,
    });
    deps.audit("bizcopilot.channel_action_executed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      tenantId: intent.tenantId,
      ...("channel" in intent && intent.channel ? { channel: intent.channel } : {}),
      ...("command" in intent ? { command: intent.command } : {}),
    });
    return context;
  } catch (error) {
    deps.audit("bizcopilot.channel_action_failed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      tenantId: intent.tenantId,
      ...("channel" in intent && intent.channel ? { channel: intent.channel } : {}),
      ...("command" in intent ? { command: intent.command } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return [
      "BIZCOPILOT_CHANNEL_ERROR:",
      error instanceof Error ? error.message : "The channel action failed.",
    ].join("\n");
  }
}
