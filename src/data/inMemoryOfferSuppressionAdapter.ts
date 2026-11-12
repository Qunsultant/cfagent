/**
 * Issue #3246 (sub-issue of #3241) — in-memory offer-suppression
 * store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 */
import {
  assertOfferSuppressionInput,
  type OfferSuppression,
  type OfferSuppressionPort,
  type OfferTrigger,
} from "./offerSuppressionPorts";

export class InMemoryOfferSuppressionAdapter implements OfferSuppressionPort {
  private rows = new Map<string, OfferSuppression>();

  async getSuppression(login: string, trigger: OfferTrigger): Promise<OfferSuppression | null> {
    return this.rows.get(`${login}\n${trigger}`) ?? null;
  }

  async setSuppression(input: {
    login: string;
    trigger: OfferTrigger;
    suppressedUntilMs: number;
    dismissedAtMs: number;
  }): Promise<OfferSuppression> {
    const validated = assertOfferSuppressionInput(input);
    this.rows.set(`${validated.login}\n${validated.trigger}`, { ...validated });
    return { ...validated };
  }
}
