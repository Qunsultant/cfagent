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
