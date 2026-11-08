/**
 * Issue #3720 (Capability S3, epic #3488) — the Stock Copilot's
 * voice ACTIVATION, resolved per voice turn.
 *
 * The voice channel itself is #3418's desk (this folder's agent.ts:
 * ETradeVoiceTradingService over the channel NLQ pipeline, the #815
 * per-turn forwarder onto the session user's OrchestratorAgent,
 * HITL order drafting with two-phase verbal confirmation). Nothing
 * here re-implements any of it. What S3 adds is the per-copilot
 * activation the capability standard declares, in the same shape
 * S4 (#3721) gave the MCP client:
 *
 * - the Stock Copilot registration declares `voice` in the #3489
 *   manifest vocabulary (src/client/chat/copilotRegistry.ts);
 * - the OrchestratorAgent class manifest — the class that hosts
 *   the channel — resolves its `voice` entry "enabled" through the
 *   existing resolver (src/actors/capabilityManifest.ts), evaluated
 *   against the turn's env, so the machinery's externalized
 *   override AGENT_CAPABILITIES_DISABLED withdraws the activation
 *   with no code change;
 * - a voice turn is "voice active" for the copilot exactly when it
 *   carries the stock registration's context carrier (the sourceTab
 *   value the chat turns carry, stamped on the voice turn request
 *   by the client/forwarder) AND that entry resolves enabled.
 *
 * The route that hosts the desk (src/agents/routes/
 * tradingIntegrations.ts) composes the activation with the desk's
 * broker gate: an active stock-context turn is served under the
 * copilot's own selection (#3451's resolveCopilotTradingSelection),
 * and the desk's approval leg keeps executing only on E*TRADE —
 * executing on the selected broker is the neutral desk's build
 * (#3556), which this slice composes with and does not fork.
 */

import {
  resolveAgentCapabilityManifest,
  type CapabilityState,
} from "../../actors/capabilityManifest";

/**
 * The stock registration's declared sourceTab — the per-turn
 * copilot carrier, the same value the chat turns carry
 * (STOCK_COPILOT_SOURCE_TAB in the mesh MCP module; the
 * registration declares it in src/client/chat/copilotRegistry.ts).
 * The two literals are pinned together by the #3720 activation
 * suite, as S4's suite pins its own pair.
 */
export const STOCK_COPILOT_VOICE_SOURCE_TAB = "Stock Copilot";

export interface StockCopilotVoiceActivation {
  /**
   * True exactly when the turn carries the stock copilot's context
   * AND the class manifest's voice entry resolves "enabled".
   */
  active: boolean;
  /** The resolved voice state for OrchestratorAgent under the given env. */
  state: CapabilityState;
}

export function resolveStockCopilotVoiceActivation(deps: {
  /** The voice turn's copilot carrier (the request's sourceTab). */
  sourceTab?: string;
  /** The deployment env the manifest resolution evaluates against. */
  env?: Record<string, unknown> | null;
}): StockCopilotVoiceActivation {
  const manifest = resolveAgentCapabilityManifest("OrchestratorAgent", {
    env: deps.env ?? undefined,
  });
  const state = manifest.channels.voice.state;
  return {
    active: deps.sourceTab === STOCK_COPILOT_VOICE_SOURCE_TAB && state === "enabled",
    state,
  };
}
