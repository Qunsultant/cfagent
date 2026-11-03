/**
 * Issue #2945 (Monetization Phase 2.17, program #2405) — cfpay channel
 * draft port. This module is the ADR 0002 R1 boundary: it imports no
 * store client, references no env binding, and writes no SQL. Only the
 * adapters (Drizzle D1, in-memory) touch a store.
 *
 * A draft is the local binding for one channel purchase: the catalogue
 * price is bound at mint (approved price only — never a proposed seed),
 * the cfpay checkout request id IS the draft id (also the replay guard),
 * and the draft carries the fulfilment outcome. A draft is never an
 * entitlement by itself: only a fulfilled draft ever granted credit,
 * and the credit itself lives on the commercial account.
 */
import type { PriceFamily } from "./priceCataloguePorts";

export type ChannelDraftStatus = "minted" | "fulfilled";

export interface ChannelDraft {
  /** The cfpay checkout request id: `cfpay-<uuid>`. Also the replay guard. */
  id: string;
  userLogin: string;
  tenantId: string;
  email: string;
  family: PriceFamily;
  /** Approved catalogue price bound at mint — never a proposed seed. */
  expectedPriceUSD: number;
  status: ChannelDraftStatus;
  createdAtMs: number;
  fulfilledAtMs: number | null;
  /** Stripe payment intent from the status record, when one is carried. */
  paymentIntentId: string | null;
  /** Why checkout.fulfil was skipped (null when fulfil ran). */
  fulfilSkippedReason: string | null;
}

export interface ChannelDraftStore {
  createDraft(draft: ChannelDraft): Promise<ChannelDraft>;
  getDraft(id: string): Promise<ChannelDraft | null>;
  markFulfilled(
    id: string,
    update: { fulfilledAtMs: number; paymentIntentId: string | null; fulfilSkippedReason: string | null },
  ): Promise<ChannelDraft>;
  listFulfilled(): Promise<ChannelDraft[]>;
  listByUser(userLogin: string): Promise<ChannelDraft[]>;
}

export function assertChannelDraftStatus(value: unknown): ChannelDraftStatus {
  if (value !== "minted" && value !== "fulfilled") {
    throw new Error(`Channel draft status must be "minted" or "fulfilled".`);
  }
  return value;
}
