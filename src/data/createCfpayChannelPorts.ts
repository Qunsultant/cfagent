/**
 * Issue #2945 — composition root for the channel draft port. This is
 * the ONLY module that maps a Worker binding to a draft
 * implementation: domain code imports this helper and the port types,
 * never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createChannelDraftAdapter` returns null and callers keep their fail
 * direction — fail-closed on money paths. A present-but-unreadable
 * store fails at the call site, where the caller decides the direction.
 */
import {
  createD1ChannelDb,
  D1ChannelDraftAdapter,
  ensureChannelSchema,
  type ChannelDraftDb,
} from "./d1CfpayChannelAdapter";
import type { ChannelDraftStore } from "./cfpayChannelPorts";

/** Build the channel draft adapter from Worker env, or null if unbound. */
export function createChannelDraftAdapter(env: { AGENT_DB?: unknown }): D1ChannelDraftAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ChannelDraftAdapter(createD1ChannelDb(env.AGENT_DB as D1Database));
}

export { ensureChannelSchema };
export type { ChannelDraftDb, ChannelDraftStore };
