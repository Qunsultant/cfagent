/**
 * Issue #3738 — externalized per-copilot CHANNEL switches (on/off).
 *
 * The channel vocabulary is the capability standard's
 * (CAPABILITY_CHANNELS in src/actors/capabilityManifest.ts: chat,
 * webhooks, email, slack, voice). Capabilities are built once on
 * the shared PortThink base so every Think agent inherits them;
 * this module is the per-REGISTRATION counterpart: whether a given
 * copilot registration (general / options / stock — the client
 * registry in src/client/chat/copilotRegistry.ts) may be reached
 * through a given channel is a configuration decision, externalized
 * in the platform's AOP idiom and resolved, per (registration,
 * channel) pair:
 *
 *   stored  — the login's own stored setting (mas_settings key
 *             `copilot_channels:<registration>`, entries
 *             `<channel>=on|off`), written through the copilot
 *             settings door (POST /stock-copilot/control). The
 *             user's own decision wins.
 *   env     — the deployment default in wrangler vars
 *             (COPILOT_CHANNELS, entries
 *             `<registration>:<channel>=on|off`), the #3727
 *             externalization precedent.
 *   default — the code default below, which records each pair's
 *             CURRENT effective behavior (see the table).
 *
 * The resolution result names its source, so a surface can show
 * WHY a channel is on or off (the #3690 precedence pattern). A
 * switch is a configuration state ABOVE the class-level machinery:
 * for a channel to serve, the switch must be ON and the agent
 * class's own capability machinery must also serve it (e.g. for
 * stock×voice, the #3720 manifest activation —
 * resolveStockCopilotVoiceActivation — must resolve enabled; the
 * consumers compose the two, this module decides only the switch).
 *
 * Code defaults — today's effective states, pair by pair:
 * - chat: ON for every registration. Chat is the base channel:
 *   all three registrations render the one conversation today.
 * - voice: ON for stock only — the #3720 activation serves
 *   stock-context voice turns; no voice channel is wired for the
 *   general or options registrations.
 * - webhooks / email / slack: OFF for every registration. Those
 *   channels terminate on the agent CLASS (the PortThink webhook
 *   tail, the shared channel desks) — no registration-scoped
 *   surface exists for any copilot, so there is nothing for a
 *   per-registration switch to enable yet. The class channels
 *   themselves are untouched by these switches.
 *
 * Malformed entries never decide anything: they are collected
 * into `issues` and surfaced in the resolution (the manifest
 * resolver's fail-visible posture), never silently applied.
 */

import {
  CAPABILITY_CHANNELS,
  type CapabilityChannelId,
} from "../actors/capabilityManifest";
import type { Env } from "../types";

/** The copilot registrations (ids pin against the client registry). */
export const COPILOT_REGISTRATION_IDS = ["general", "options", "stock"] as const;
export type CopilotRegistrationId = (typeof COPILOT_REGISTRATION_IDS)[number];

export function isCopilotRegistrationId(
  value: unknown,
): value is CopilotRegistrationId {
  return (
    typeof value === "string" &&
    (COPILOT_REGISTRATION_IDS as readonly string[]).includes(value)
  );
}

/**
 * Each registration's context carrier — the sourceTab value its
 * turns carry (the client registry declares the same literals;
 * the #3738 suite pins the pair, as the #3720/#3721 suites pin
 * theirs).
 */
export const COPILOT_REGISTRATION_SOURCE_TABS: Record<
  CopilotRegistrationId,
  string
> = {
  general: "Chat & Agents",
  options: "Broker · Auto Options Research",
  stock: "Stock Copilot",
};

/** The deployment-layer var (wrangler vars): entries `<registration>:<channel>=on|off`. */
export const COPILOT_CHANNELS_ENV = "COPILOT_CHANNELS";

/** The named refusal code for a turn on a switched-off channel. */
export const COPILOT_CHANNEL_DISABLED = "COPILOT_CHANNEL_DISABLED";

/** The per-login stored-settings key for one registration's channel decisions. */
export function copilotChannelsSettingKey(
  registrationId: CopilotRegistrationId,
): string {
  return `copilot_channels:${registrationId}`;
}

export type CopilotChannelSwitchSource = "stored" | "env" | "default";

export interface CopilotChannelResolution {
  registrationId: CopilotRegistrationId;
  channel: CapabilityChannelId;
  /** The switch state (the class-level machinery composes separately). */
  enabled: boolean;
  /** Which layer decided: the login's stored setting, the deployment env, or the code default. */
  source: CopilotChannelSwitchSource;
  /** Malformed entries encountered while resolving — surfaced, never applied. */
  issues: string[];
}

/**
 * THE code-default layer: one named table holding every
 * (registration × channel) code default — today's effective
 * states (see the module header for the per-pair reasoning).
 * This table is the ONLY place a code default lives; the
 * resolver reads it and nothing else falls back ad hoc. It is
 * exported as the seam the per-agent configuration slice
 * (#3741) generalizes: a future defaults change is a table
 * edit here, never a new fallback at a call site.
 */
export const COPILOT_CHANNEL_DEFAULTS: Record<
  CopilotRegistrationId,
  Record<CapabilityChannelId, boolean>
> = {
  general: { chat: true, webhooks: false, email: false, slack: false, voice: false },
  options: { chat: true, webhooks: false, email: false, slack: false, voice: false },
  stock: { chat: true, webhooks: false, email: false, slack: false, voice: true },
};

function parseSwitchValue(token: string): boolean | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  return null;
}

function isChannelId(value: string): value is CapabilityChannelId {
  return (CAPABILITY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Parse the STORED form — entries `<channel>=on|off>` under one
 * registration's settings key. Unknown channels and unparseable
 * values decide nothing and are reported as issues.
 */
export function parseStoredCopilotChannelEntries(
  raw: string | null | undefined,
): {
  decisions: Partial<Record<CapabilityChannelId, boolean>>;
  issues: string[];
} {
  const decisions: Partial<Record<CapabilityChannelId, boolean>> = {};
  const issues: string[] = [];
  if (typeof raw !== "string") return { decisions, issues };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const channel = eq > 0 ? trimmed.slice(0, eq).trim().toLowerCase() : "";
    const value = eq > 0 ? parseSwitchValue(trimmed.slice(eq + 1)) : null;
    if (!isChannelId(channel) || value === null) {
      issues.push(
        `copilot channel setting: malformed entry "${trimmed}" (expected "<channel>=on|off")`,
      );
      continue;
    }
    decisions[channel] = value;
  }
  return { decisions, issues };
}

/**
 * Parse the ENV form — entries `<registration>:<channel>=on|off>`
 * in the single COPILOT_CHANNELS var. Keys are
 * `${registration}:${channel}`. Malformed entries decide nothing
 * and are reported as issues.
 */
export function parseEnvCopilotChannelEntries(
  raw: string | null | undefined,
): { decisions: Map<string, boolean>; issues: string[] } {
  const decisions = new Map<string, boolean>();
  const issues: string[] = [];
  if (typeof raw !== "string") return { decisions, issues };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.lastIndexOf("=");
    const lhs = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    const value = eq > 0 ? parseSwitchValue(trimmed.slice(eq + 1)) : null;
    const sep = lhs.indexOf(":");
    const registration = sep > 0 ? lhs.slice(0, sep).trim().toLowerCase() : "";
    const channel = sep > 0 ? lhs.slice(sep + 1).trim().toLowerCase() : "";
    if (!isCopilotRegistrationId(registration) || !isChannelId(channel) || value === null) {
      issues.push(
        `${COPILOT_CHANNELS_ENV}: malformed entry "${trimmed}" (expected "<registration>:<channel>=on|off")`,
      );
      continue;
    }
    decisions.set(`${registration}:${channel}`, value);
  }
  return { decisions, issues };
}

/** Serialize stored decisions in canonical channel order (`voice=off,slack=on`). */
export function serializeStoredCopilotChannelEntries(
  decisions: Partial<Record<CapabilityChannelId, boolean>>,
): string {
  return CAPABILITY_CHANNELS.filter((channel) => decisions[channel] !== undefined)
    .map((channel) => `${channel}=${decisions[channel] ? "on" : "off"}`)
    .join(",");
}

/**
 * Resolve one (registration × channel) switch: the login's stored
 * decision wins, then the deployment env, then the code default.
 * Never throws; malformed config is reported in `issues`.
 */
export function resolveCopilotChannel(deps: {
  registrationId: CopilotRegistrationId;
  channel: CapabilityChannelId;
  /** The hosting instance's settings reader (absent ⇒ no stored layer). */
  readSettingRaw?: (key: string) => string | null;
  /** The deployment env (absent ⇒ no env layer). */
  env?: Env | Record<string, unknown> | null;
}): CopilotChannelResolution {
  const { registrationId, channel } = deps;
  const issues: string[] = [];

  if (deps.readSettingRaw) {
    const stored = parseStoredCopilotChannelEntries(
      deps.readSettingRaw(copilotChannelsSettingKey(registrationId)),
    );
    issues.push(...stored.issues);
    const decision = stored.decisions[channel];
    if (decision !== undefined) {
      return { registrationId, channel, enabled: decision, source: "stored", issues };
    }
  }

  const envRaw = deps.env
    ? (deps.env as Record<string, unknown>)[COPILOT_CHANNELS_ENV]
    : undefined;
  const envParsed = parseEnvCopilotChannelEntries(
    typeof envRaw === "string" ? envRaw : undefined,
  );
  issues.push(...envParsed.issues);
  const envDecision = envParsed.decisions.get(`${registrationId}:${channel}`);
  if (envDecision !== undefined) {
    return { registrationId, channel, enabled: envDecision, source: "env", issues };
  }

  return {
    registrationId,
    channel,
    enabled: COPILOT_CHANNEL_DEFAULTS[registrationId][channel],
    source: "default",
    issues,
  };
}

/** Resolve every channel switch for one registration. */
export function resolveCopilotChannels(deps: {
  registrationId: CopilotRegistrationId;
  readSettingRaw?: (key: string) => string | null;
  env?: Env | Record<string, unknown> | null;
}): Record<CapabilityChannelId, CopilotChannelResolution> {
  const out = {} as Record<CapabilityChannelId, CopilotChannelResolution>;
  for (const channel of CAPABILITY_CHANNELS) {
    out[channel] = resolveCopilotChannel({ ...deps, channel });
  }
  return out;
}
