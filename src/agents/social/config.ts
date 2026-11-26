/**
 * #1077 Phase 4 — social posting configuration (drafts only).
 *
 * Reads the social channel split from Env. The confirmed split from issue
 * #1077 is the DEFAULT, not a hardcoded list: the owner moves a channel
 * across the line by changing config, never by a code change.
 *
 * Variable names and defaults (owner-confirmed, #1077):
 * - SOCIAL_POSTING_ENABLED: "1"/"true" = on, default OFF.
 * - SOCIAL_AUTONOMOUS_CHANNELS: default "threads,x".
 * - SOCIAL_APPROVAL_CHANNELS: default "facebook,instagram,linkedin".
 *
 * Parsing follows the comma-split-trim pattern of enabledProviders in
 * src/security/providers.ts, with one deliberate difference: an UNSET
 * variable yields the default, while an EXPLICITLY BLANK variable yields
 * an empty list — otherwise "empty autonomous list means everything
 * needs approval" could never be expressed in config.
 *
 * Fail-closed rules (all enforced by resolveChannelDisposition):
 * 1. A channel in BOTH lists resolves to approval.
 * 2. An unknown channel id resolves to approval, never autonomous.
 * 3. A known channel in NEITHER list resolves to approval.
 * 4. An empty autonomous list means everything needs approval.
 * 5. A channel with no configured token must never be posted — see
 *    canPublish. No token storage is built in this phase, so callers pass
 *    hasToken explicitly (always false until Phase 5 wires tokens).
 *
 * This module performs no network calls and holds no secrets.
 */

import { resolveEnvironmentConfig } from "../../config/environment";
import type { Env } from "../../types";

export const KNOWN_SOCIAL_CHANNELS = [
  "threads",
  "x",
  "facebook",
  "instagram",
  "linkedin",
] as const;

export type SocialChannel = (typeof KNOWN_SOCIAL_CHANNELS)[number];

export type SocialDisposition = "autonomous" | "approval";

/** Minimal Env shape: only the three SOCIAL_* variables, all optional. */
export interface SocialEnv {
  SOCIAL_POSTING_ENABLED?: string;
  SOCIAL_AUTONOMOUS_CHANNELS?: string;
  SOCIAL_APPROVAL_CHANNELS?: string;
}

export interface SocialConfig {
  postingEnabled: boolean;
  autonomousChannels: string[];
  approvalChannels: string[];
}

const DEFAULT_AUTONOMOUS = ["threads", "x"];
const DEFAULT_APPROVAL = ["facebook", "instagram", "linkedin"];

function parseChannelList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function parseSocialConfig(env: SocialEnv | null | undefined): SocialConfig {
  // Phase 3 (#6550): SOCIAL_POSTING_ENABLED and
  // SOCIAL_AUTONOMOUS_CHANNELS live in environment.config.json
  // (defaults.social); a still-set env var wins. The unset-vs-blank
  // distinction for the channel list is preserved: an explicitly
  // blank env value still yields an empty list.
  const resolved = resolveEnvironmentConfig(
    env as Partial<Env> | undefined,
  ).workerSettings.social;
  return {
    postingEnabled: resolved.postingEnabled,
    autonomousChannels: parseChannelList(
      env?.SOCIAL_AUTONOMOUS_CHANNELS ?? resolved.autonomousChannels,
      DEFAULT_AUTONOMOUS,
    ),
    approvalChannels: parseChannelList(env?.SOCIAL_APPROVAL_CHANNELS, DEFAULT_APPROVAL),
  };
}

/**
 * Phase 3 (#6550): the SocialEnv object the scheduled pipeline and
 * the messaging routes forward, rendered from the resolved context
 * so a downstream reader never sees a blank moved var. The two moved
 * flags render as "1"/"0"; the autonomous list renders from the file
 * (env wins when set); SOCIAL_APPROVAL_CHANNELS stays an env-only
 * read. Named `build*`, not `resolve*`, so it does not count toward
 * the resolver census (Phase 2 pin).
 */
export function buildSocialEnv(
  env: (SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string }) | null | undefined,
): SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string } {
  const resolved = resolveEnvironmentConfig(
    env as Partial<Env> | undefined,
  ).workerSettings.social;
  return {
    SOCIAL_POSTING_ENABLED: resolved.postingEnabled ? "1" : "0",
    SOCIAL_AUTONOMOUS_CHANNELS: env?.SOCIAL_AUTONOMOUS_CHANNELS ?? resolved.autonomousChannels,
    SOCIAL_APPROVAL_CHANNELS: env?.SOCIAL_APPROVAL_CHANNELS,
    SOCIAL_LIVE_PUBLISHING: resolved.livePublishing ? "1" : "0",
  };
}

/** All channels the config enables, autonomous + approval, deduplicated. */
export function enabledChannels(config: SocialConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...config.autonomousChannels, ...config.approvalChannels]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function isKnownChannel(id: string): id is SocialChannel {
  return (KNOWN_SOCIAL_CHANNELS as readonly string[]).includes(id);
}

/**
 * Fail-closed disposition. A channel is autonomous ONLY when it is known,
 * listed in the autonomous list, and NOT listed in the approval list.
 * Every other case — unknown id, both lists, neither list, empty
 * autonomous list — resolves to approval.
 */
export function resolveChannelDisposition(
  channel: string,
  config: SocialConfig,
): SocialDisposition {
  const id = channel.trim().toLowerCase();
  if (!isKnownChannel(id)) return "approval";
  if (config.approvalChannels.includes(id)) return "approval";
  if (config.autonomousChannels.includes(id)) return "autonomous";
  return "approval";
}

/**
 * Token gate for a future publish step. Without a token, nothing may be
 * posted — regardless of which list the channel is on. Unknown channels
 * never pass even with a token. Phase 4 has no token storage, so callers
 * pass hasToken = false until Phase 5 wires platform tokens.
 */
export function canPublish(
  channel: string,
  hasToken: boolean,
  _config: SocialConfig,
): boolean {
  if (!hasToken) return false;
  return isKnownChannel(channel.trim().toLowerCase());
}
