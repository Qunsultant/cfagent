/**
 * Issue #2441 (program #2442 slice S2) — broker-dispatched token
 * rejection propagation.
 *
 * An upstream rejection is a fact about token state and must propagate
 * to the store that serves tokens: a consumer that silently re-serves a
 * rejected token holds a second truth about provider state. This module
 * is the dispatch point for that rule, shaped so the same handling
 * generalizes to any broker (owner broker-agnostic rule, 2026-10-30):
 * the caller names the broker, and exactly one branch per broker knows
 * how that broker's tokens are stored and dropped. S4 extends the
 * dispatch with the remaining brokers; it does not re-shape it.
 *
 * Today only "etrade" is implemented: the dead token is dropped from
 * every key scope the seam can reach (login variants, plus internal-id
 * and alias-login keys when identity is known) and the isolate cache is
 * invalidated, both via revokeStoredTokens — so the next read cannot
 * re-serve it. An unknown broker is a fail-closed no-op: handled false,
 * nothing touched, never another broker's tokens. A remote (upstream)
 * revoke is deliberately NOT attempted here: E*TRADE already rejected
 * the pair, so there is nothing live left to revoke upstream, and a
 * remote call would only add a failing request to an already-failed
 * read. Propagation itself never throws: a drop failure is recorded
 * and reported as dropped false, so it can never mask the original
 * upstream error or break the read path.
 *
 * Never logs token values — presence and key scope only.
 */
import type { Env } from "../types";
import {
  revokeStoredTokens,
  type ETradeTokenIdentity,
} from "./etradeOAuth";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

export interface BrokerTokenRejectionInput {
  broker: string;
  env: Env;
  userLogin: string;
  overrideEnv?: string;
  identity?: ETradeTokenIdentity;
}

export interface BrokerTokenRejectionResult {
  broker: string;
  handled: boolean;
  dropped: boolean;
}

export async function propagateBrokerTokenRejection(
  input: BrokerTokenRejectionInput
): Promise<BrokerTokenRejectionResult> {
  if (input.broker !== "etrade") {
    return { broker: input.broker, handled: false, dropped: false };
  }
  // Issue #3515 S3 batch 8 — env-wired logger: the sink is built from
  // the request's env so the event reaches the Analytics Engine
  // `observability` dataset (never an empty-env sink, #5587).
  const structuredLog = createStructuredLogger(createObservabilitySink(input.env), {
    component: "security/brokerTokenRejection",
  });
  try {
    await revokeStoredTokens(
      input.env,
      input.userLogin,
      input.overrideEnv,
      input.identity
    );
    return { broker: "etrade", handled: true, dropped: true };
  } catch (err) {
    structuredLog.warn("brokerTokenRejection.token_drop_failed", {
      message: `[BrokerTokenRejection] etrade token drop failed for ${input.userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      userLogin: input.userLogin,
      error: err instanceof Error ? err.message : String(err),
    });
    return { broker: "etrade", handled: true, dropped: false };
  }
}
