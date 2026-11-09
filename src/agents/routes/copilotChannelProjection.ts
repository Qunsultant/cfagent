/**
 * The copilot channel-switch projection, shared by every surface
 * that renders a channel affordance (issues #3738, #3773).
 *
 * The composition rule lives exactly once, here: a registration's
 * channel switches resolve through the ONE resolver
 * (src/services/copilotChannels.ts — stored > env > code-default,
 * source named), and the voice channel additionally composes with
 * the class-level activation (#3720): the switch AND the manifest
 * activation must both be on for voice to serve (`effective`); the
 * activation's manifest state rides along so the two configuration
 * layers stay distinguishable.
 *
 * Consumers: the Stock Copilot status read (routes/stockCopilot.ts,
 * #3738 — the panel's voice affordance) and the chat surface's
 * per-registration read (routes/copilotChannels.ts, #3773 — the
 * composer mic). Both project through this helper so the surfaces
 * can never disagree about whether a channel serves.
 */

import {
  COPILOT_REGISTRATION_SOURCE_TABS,
  resolveCopilotChannels,
  type CopilotChannelResolution,
  type CopilotRegistrationId,
} from "../../services/copilotChannels";
import {
  resolveCopilotVoiceBackend,
  resolveVoiceBackend,
  type CopilotVoiceBackendId,
  type VoiceSurfaceId,
} from "../../services/copilotVoiceBackend";
import { resolveStockCopilotVoiceActivation } from "../../trading";
import type { Env } from "../../types";

/** One channel's wire projection: the switch state + deciding layer. */
export interface CopilotChannelStatus {
  enabled: boolean;
  source: CopilotChannelResolution["source"];
}

/** The voice channel's wire projection: switch composed with the activation. */
export interface CopilotVoiceChannelStatus extends CopilotChannelStatus {
  manifestState: string;
  effective: boolean;
}

/** Every channel's projection for one copilot registration. */
export interface CopilotChannelsProjection {
  chat: CopilotChannelStatus;
  webhooks: CopilotChannelStatus;
  email: CopilotChannelStatus;
  slack: CopilotChannelStatus;
  voice: CopilotVoiceChannelStatus;
}

/**
 * Project one registration's channel statuses. `readSettingRaw`
 * is the hosting instance's per-login settings reader (the stored
 * layer); `env` is the deployment env (the env layer + the
 * manifest resolution's externalized overrides).
 */
export function projectCopilotChannelStatuses(deps: {
  registrationId: CopilotRegistrationId;
  readSettingRaw?: (key: string) => string | null;
  env?: Env | Record<string, unknown> | null;
}): CopilotChannelsProjection {
  const switches = resolveCopilotChannels({
    registrationId: deps.registrationId,
    readSettingRaw: deps.readSettingRaw,
    env: deps.env,
  });
  const activation = resolveStockCopilotVoiceActivation({
    sourceTab: COPILOT_REGISTRATION_SOURCE_TABS[deps.registrationId],
    env: deps.env as Record<string, unknown> | undefined,
  });
  const project = (r: CopilotChannelResolution): CopilotChannelStatus => ({
    enabled: r.enabled,
    source: r.source,
  });
  return {
    chat: project(switches.chat),
    webhooks: project(switches.webhooks),
    email: project(switches.email),
    slack: project(switches.slack),
    voice: {
      ...project(switches.voice),
      manifestState: activation.state,
      effective: switches.voice.enabled && activation.state === "enabled",
    },
  };
}

/**
 * The voice channel's BACKEND projection (#3773): which speech
 * machinery serves the registration's voice turns — the #3738-style
 * switch in src/services/copilotVoiceBackend.ts (stored > env >
 * code default, source named). It rides BESIDE the channel
 * projection in both reads: the channel gates whether voice serves
 * at all; the backend only chooses how.
 */
export interface CopilotVoiceBackendStatus {
  backend: CopilotVoiceBackendId;
  source: CopilotChannelResolution["source"];
}

export function projectCopilotVoiceBackend(deps: {
  registrationId: CopilotRegistrationId;
  readSettingRaw?: (key: string) => string | null;
  env?: Env | Record<string, unknown> | null;
}): CopilotVoiceBackendStatus {
  const resolution = resolveCopilotVoiceBackend(deps);
  return { backend: resolution.backend, source: resolution.source };
}

/** One voice surface's wire projection (#3796): the same shape, keyed by surface. */
export interface VoiceSurfaceBackendStatus {
  backend: CopilotVoiceBackendId;
  source: CopilotChannelResolution["source"];
}

/**
 * Project one SURFACE's voice backend (#3796): the surface-keyed
 * form of the projection above — the trading desk's read and any
 * future surface project through this, so every surface's
 * backend decision is resolved and named the same way.
 */
export function projectVoiceBackend(deps: {
  surfaceId: VoiceSurfaceId;
  readSettingRaw?: (key: string) => string | null;
  env?: Env | Record<string, unknown> | null;
}): VoiceSurfaceBackendStatus {
  const resolution = resolveVoiceBackend(deps);
  return { backend: resolution.backend, source: resolution.source };
}
