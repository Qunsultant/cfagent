/**
 * Issue #4249 ([3122] agentic scheduling): the two scheduling-channel
 * flags, the one-on invariant, and the channel authorization gate.
 *
 * The platform's one flag mechanism is the FeatureFlagPort
 * (src/features/): these flags are registered in ALL_FEATURE_FLAGS
 * and evaluated through it — no second flag mechanism exists.
 *
 * Channels (chat FIRST, wherever they are presented or ordered):
 * - "chat" — schedule requests from the chat (the schedule.* A2A
 *   ops, served by src/agents/orchestrator/a2aDispatch.ts). Gated by
 *   the "schedule_chat" flag, default ON: chat is the default channel.
 * - "nlq" — the NLQ schedule intents (nlq.execute's scheduling plans,
 *   served by src/agents/nlq/execution.ts). Gated by the
 *   "schedule_nlq" flag, default OFF: NLQ is secondary and off
 *   unless the owner turns it on.
 *
 * The flags gate the ENTRY POINTS, not the operations: the underlying
 * schedule.* A2A operations and the agent schedule capability stay
 * the one mechanism, ungated internally.
 *
 * One-on invariant: at least one channel must be on. A both-off
 * configuration is not a valid state — a schedule request arriving
 * while both are off is refused with the coded outcome
 * SCHEDULE_CHANNELS_BOTH_OFF, never silently and never unguarded.
 * A request on a single disabled channel (the other one on) is
 * refused with the coded outcome FEATURE_DISABLED.
 *
 * This module is deliberately free of Cloudflare runtime types,
 * environment inspection, and provider bindings, like
 * featureFlagPorts.ts: callers pass a FeatureFlagPort (or the gate
 * resolves one from env via the composition root).
 */

import {
  DEFAULT_SCHEDULE_CHAT_FLAG_VALUE,
  DEFAULT_SCHEDULE_NLQ_FLAG_VALUE,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  type FeatureFlagWriteResult,
} from "./featureFlagPorts";

/** Issue #4249: the flag gating schedule requests from the chat. */
export const SCHEDULE_CHAT_FLAG = "schedule_chat" satisfies FeatureFlag;

/** Issue #4249: the flag gating the NLQ schedule intents. */
export const SCHEDULE_NLQ_FLAG = "schedule_nlq" satisfies FeatureFlag;

/** Issue #4249: the two agentic-scheduling entry points. */
export type ScheduleChannel = "chat" | "nlq";

/**
 * Issue #4249 (chat-first rule): the canonical channel order —
 * chat comes first, NLQ is never first. Any surface that presents
 * or orders the channels derives its order from this list.
 */
export const SCHEDULE_CHANNELS: readonly ScheduleChannel[] = ["chat", "nlq"] as const;

/** Issue #4249: the flag behind each channel. */
export const SCHEDULE_CHANNEL_FLAGS: Readonly<Record<ScheduleChannel, FeatureFlag>> = {
  chat: SCHEDULE_CHAT_FLAG,
  nlq: SCHEDULE_NLQ_FLAG,
} as const;

/** Issue #4249: the unconfigured default behind each channel. */
export const SCHEDULE_CHANNEL_DEFAULTS: Readonly<Record<ScheduleChannel, boolean>> = {
  chat: DEFAULT_SCHEDULE_CHAT_FLAG_VALUE,
  nlq: DEFAULT_SCHEDULE_NLQ_FLAG_VALUE,
} as const;

/** Coded refusal outcomes for a scheduling-channel request. */
export type ScheduleChannelRefusalCode = "FEATURE_DISABLED" | "SCHEDULE_CHANNELS_BOTH_OFF";

/** The resolved on/off state of both scheduling channels. */
export interface ScheduleChannelState {
  chatEnabled: boolean;
  nlqEnabled: boolean;
}

/** Resolve both channel flags through the existing FeatureFlagPort. */
export async function resolveScheduleChannelState(
  port: FeatureFlagPort,
  context?: FeatureEvaluationContext,
): Promise<ScheduleChannelState> {
  const [chatEnabled, nlqEnabled] = await Promise.all([
    port.isEnabled(SCHEDULE_CHAT_FLAG, context),
    port.isEnabled(SCHEDULE_NLQ_FLAG, context),
  ]);
  return { chatEnabled, nlqEnabled };
}

/**
 * Issue #4249: the one-on invariant as a pure check — at least one
 * channel must be on. Both off is refused with a coded outcome
 * (SCHEDULE_CHANNELS_BOTH_OFF), never a silent dead end.
 */
export function validateScheduleChannelState(
  state: ScheduleChannelState,
):
  | { ok: true }
  | { ok: false; code: "SCHEDULE_CHANNELS_BOTH_OFF"; message: string } {
  if (!state.chatEnabled && !state.nlqEnabled) {
    return {
      ok: false,
      code: "SCHEDULE_CHANNELS_BOTH_OFF",
      message:
        "Both scheduling channels are off (schedule_chat and schedule_nlq): at least one channel must be on — chat is the default. Turn chat or NLQ on; scheduling stays refused until then.",
    };
  }
  return { ok: true };
}

export type ScheduleChannelAuthorization =
  | { allowed: true; state: ScheduleChannelState }
  | {
      allowed: false;
      code: ScheduleChannelRefusalCode;
      /** The flag behind the refused channel. */
      flag: FeatureFlag;
      message: string;
      state: ScheduleChannelState;
    };

/**
 * Issue #4249: authorize one scheduling request on one channel.
 * Fail-closed throughout: the both-off state refuses with
 * SCHEDULE_CHANNELS_BOTH_OFF; a single disabled channel refuses
 * with FEATURE_DISABLED; an evaluation failure refuses with
 * FEATURE_DISABLED (the channel cannot be proven on).
 */
export async function authorizeScheduleChannel(
  port: FeatureFlagPort,
  channel: ScheduleChannel,
  context?: FeatureEvaluationContext,
): Promise<ScheduleChannelAuthorization> {
  const bothOff: ScheduleChannelState = { chatEnabled: false, nlqEnabled: false };
  let state: ScheduleChannelState;
  try {
    state = await resolveScheduleChannelState(port, context);
  } catch (err) {
    return {
      allowed: false,
      code: "FEATURE_DISABLED",
      flag: SCHEDULE_CHANNEL_FLAGS[channel],
      message: `Scheduling via ${channel} is disabled (FEATURE_DISABLED): the ${SCHEDULE_CHANNEL_FLAGS[channel]} flag could not be evaluated (${err instanceof Error ? err.message : String(err)}), so the request was refused, not executed.`,
      state: bothOff,
    };
  }
  const invariant = validateScheduleChannelState(state);
  if (!invariant.ok) {
    return {
      allowed: false,
      code: invariant.code,
      flag: SCHEDULE_CHANNEL_FLAGS[channel],
      message: invariant.message,
      state,
    };
  }
  const enabled = channel === "chat" ? state.chatEnabled : state.nlqEnabled;
  if (!enabled) {
    return {
      allowed: false,
      code: "FEATURE_DISABLED",
      flag: SCHEDULE_CHANNEL_FLAGS[channel],
      message: `Scheduling via ${channel} is disabled by feature flag ${SCHEDULE_CHANNEL_FLAGS[channel]} (FEATURE_DISABLED). Turn the channel on to schedule through it; the other channel stays available.`,
      state,
    };
  }
  return { allowed: true, state };
}

/**
 * Issue #4260 ([3121] surface the scheduling-channel flags in the
 * schedules home): the flag gating the schedules surface itself
 * (TAB_TO_FEATURE_MAP maps the schedules tab to it). It is surfaced
 * read-only: turning off the gate of the home you are standing in
 * would strand the caller, so only the two channel flags toggle.
 */
export const SCHEDULES_FLAG = "schedules" satisfies FeatureFlag;

/** One flag row of the schedules-home flags section. */
export interface ScheduleHomeFlag {
  flag: FeatureFlag;
  /** The channel behind the flag, or null for the surface flag. */
  channel: ScheduleChannel | null;
  label: string;
  /**
   * The unconfigured default, or null when no single default exists
   * (the schedules flag resolves adapter-by-adapter).
   */
  defaultValue: boolean | null;
  /** False for the schedules surface flag — read-only in the home. */
  toggleable: boolean;
}

/**
 * Issue #4260: the flags the schedules home surfaces, chat first
 * (the #4249 chat-first rule), then NLQ, then the schedules surface
 * flag. Any surface that presents these flags derives its order
 * from this list — never a local literal.
 */
export const SCHEDULE_HOME_FLAGS: readonly ScheduleHomeFlag[] = [
  {
    flag: SCHEDULE_CHAT_FLAG,
    channel: "chat",
    label: "Chat",
    defaultValue: DEFAULT_SCHEDULE_CHAT_FLAG_VALUE,
    toggleable: true,
  },
  {
    flag: SCHEDULE_NLQ_FLAG,
    channel: "nlq",
    label: "NLQ",
    defaultValue: DEFAULT_SCHEDULE_NLQ_FLAG_VALUE,
    toggleable: true,
  },
  {
    flag: SCHEDULES_FLAG,
    channel: null,
    label: "Schedules",
    defaultValue: null,
    toggleable: false,
  },
] as const;

/** One resolved flag row for the home (live state + metadata). */
export interface ResolvedScheduleHomeFlag extends ScheduleHomeFlag {
  enabled: boolean;
}

/** The schedules-home flags view: live state through the port. */
export interface ScheduleChannelFlagsView {
  flags: ResolvedScheduleHomeFlag[];
  channels: ScheduleChannelState;
  /** True when the port implements setEnabled (the toggle can take effect). */
  writable: boolean;
}

/** Resolve the home flags view through the existing FeatureFlagPort. */
export async function resolveScheduleChannelFlagsView(
  port: FeatureFlagPort,
  context?: FeatureEvaluationContext,
): Promise<ScheduleChannelFlagsView> {
  const state = await resolveScheduleChannelState(port, context);
  const schedulesEnabled = await port.isEnabled(SCHEDULES_FLAG, context);
  // All three home flags are always present; the fallback never fires.
  const enabledByFlag = new Map<FeatureFlag, boolean>([
    [SCHEDULE_CHAT_FLAG, state.chatEnabled],
    [SCHEDULE_NLQ_FLAG, state.nlqEnabled],
    [SCHEDULES_FLAG, schedulesEnabled],
  ]);
  return {
    flags: SCHEDULE_HOME_FLAGS.map((flag) => ({
      ...flag,
      enabled: enabledByFlag.get(flag.flag) ?? false,
    })),
    channels: state,
    writable: typeof port.setEnabled === "function",
  };
}

/** Coded outcomes for a schedules-home flag toggle. */
export type ScheduleChannelToggleCode =
  | "SCHEDULE_CHANNELS_BOTH_OFF"
  | "FLAG_NOT_TOGGLEABLE"
  | "FLAG_WRITE_UNSUPPORTED"
  | "UNKNOWN_FLAG"
  | "FEATURE_DISABLED";

export type ScheduleChannelToggleResult =
  | { ok: true; state: ScheduleChannelState }
  | {
      ok: false;
      code: ScheduleChannelToggleCode;
      message: string;
      state: ScheduleChannelState;
    };

/**
 * Issue #4260: apply one schedules-home toggle through the existing
 * FeatureFlagPort. The one-on invariant is enforced before any
 * write (turning the last channel off is refused with
 * SCHEDULE_CHANNELS_BOTH_OFF); the schedules surface flag and
 * unknown flags are refused; a port with no write reports
 * FLAG_WRITE_UNSUPPORTED — the caller names the operator-owned
 * source, never a second flag store. Fail-closed throughout: an
 * evaluation failure refuses with FEATURE_DISABLED.
 */
export async function applyScheduleChannelToggle(
  port: FeatureFlagPort,
  flag: string,
  enabled: boolean,
  context?: FeatureEvaluationContext,
): Promise<ScheduleChannelToggleResult> {
  const bothOff: ScheduleChannelState = { chatEnabled: false, nlqEnabled: false };
  let state: ScheduleChannelState;
  try {
    state = await resolveScheduleChannelState(port, context);
  } catch (err) {
    return {
      ok: false,
      code: "FEATURE_DISABLED",
      message: `The scheduling-channel flags could not be evaluated (${err instanceof Error ? err.message : String(err)}), so the toggle was refused, not applied.`,
      state: bothOff,
    };
  }
  const homeFlag = SCHEDULE_HOME_FLAGS.find((entry) => entry.flag === flag);
  if (!homeFlag) {
    return {
      ok: false,
      code: "UNKNOWN_FLAG",
      message: `Unknown feature flag '${flag}': refusing the toggle.`,
      state,
    };
  }
  if (!homeFlag.toggleable) {
    return {
      ok: false,
      code: "FLAG_NOT_TOGGLEABLE",
      message: `The '${flag}' flag gates the schedules home itself, so it is read-only here — change it where the flag is managed instead.`,
      state,
    };
  }
  const next: ScheduleChannelState =
    homeFlag.channel === "chat"
      ? { chatEnabled: enabled, nlqEnabled: state.nlqEnabled }
      : { chatEnabled: state.chatEnabled, nlqEnabled: enabled };
  const invariant = validateScheduleChannelState(next);
  if (!invariant.ok) {
    return { ok: false, code: invariant.code, message: invariant.message, state };
  }
  if (typeof port.setEnabled !== "function") {
    return {
      ok: false,
      code: "FLAG_WRITE_UNSUPPORTED",
      message: `The '${flag}' flag is managed outside this runtime (the operator-owned flag source), so the home cannot persist the toggle — change it where the flag is managed instead.`,
      state,
    };
  }
  let written: FeatureFlagWriteResult;
  try {
    written = await port.setEnabled(flag, enabled, context);
  } catch (err) {
    return {
      ok: false,
      code: "FEATURE_DISABLED",
      message: `The '${flag}' flag could not be written (${err instanceof Error ? err.message : String(err)}), so the toggle was refused, not applied.`,
      state,
    };
  }
  if (!written.ok) {
    const code: ScheduleChannelToggleCode =
      written.code === "UNKNOWN_FLAG" ? "UNKNOWN_FLAG" : "FLAG_WRITE_UNSUPPORTED";
    return { ok: false, code, message: written.message, state };
  }
  const after = await resolveScheduleChannelState(port, context);
  return { ok: true, state: after };
}
