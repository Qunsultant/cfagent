/**
 * Issue #932: draft → owning-instance registry for gateway webhook
 * settlement.
 *
 * The bug: external payment webhooks are intercepted in src/server.ts and
 * forwarded to the single OrchestratorAgent instance
 * `system_webhook_receiver`, but payment drafts are created in PER-USER
 * instances (POST /payments/create, the MAS draftPayment tool, the MCP
 * draft_payment command), each owning a separate SQLite store. The
 * settlement UPDATE in the webhook handler therefore ran against the
 * receiver instance's store, matched 0 rows for every real draft, and
 * still returned { received: true }.
 *
 * The registry is the resolution the settlement path was missing. Every
 * draft create path records, at insert time, which instance owns the
 * draft: key `draftowner:<draftId>` in the SessionStore "payments" bucket
 * (the same bucket the x402 replay guard uses, src/services/
 * agenticPayments.ts), value = the session identity the draft row was
 * written under — literally the value stored in the row's own session_id
 * column (OrchestratorAgent.sessionKey()). The webhook handler resolves
 * the owner from this entry and forwards the verified webhook to that
 * instance over the SEARCH_AGENT stub channel (the persistAudit / #896
 * ledger pattern); routing is derived ONLY from this server-written
 * entry — the webhook payload contributes nothing but the draftId, so a
 * caller cannot steer a settlement across tenants.
 *
 * Registration uses the store's atomic consume op: the first owner
 * stands. A draftId collision (ids are `pay_` + 8 hex chars) therefore
 * keeps the original owner's routing instead of letting a later create
 * hijack it, and the second owner's settlement fails loud as unmatched
 * rather than settling the wrong tenant's row.
 *
 * Entries deliberately carry no TTL: mas_transactions rows themselves
 * are retained (the #786 KEEP decision), and a routing entry that
 * expired before a late settlement would turn a real settlement into
 * an unmatched one. One small key per draft, alongside the row it
 * routes to.
 */
import {
  createBucketPorts,
  isBucketPortsEnabled,
} from "../data/createBucketPorts";
import {
  consumeStoreKey,
  createStoreKv,
  type DoNamespaceLike,
} from "../data/durableKv";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "payments/draftOwners",
});

/** SessionStore bucket shared with the x402 replay guard. */
export const DRAFT_OWNER_NAMESPACE = "payments";

/** Registry key prefix inside the bucket: `draftowner:<draftId>`. */
export const DRAFT_OWNER_KEY_PREFIX = "draftowner:";

/**
 * Internal header marking a webhook request as a settlement hop: set by
 * the receiving instance when it forwards a verified webhook to the
 * draft-owning instance, valued with the registry's owner identity. The
 * target settles only when the header names ITSELF; any other value is
 * a misroute and is refused loud. External callers cannot use this
 * header to steer settlement: the worker's webhook interception always
 * lands on the receiver instance, whose own identity never matches a
 * header naming someone else (see the webhook handler in
 * src/agents/routes/payments.ts).
 */
export const SETTLEMENT_OWNER_HEADER = "x-webhook-settlement-owner";

export type DraftOwnerRegistration = "registered" | "duplicate" | "unavailable";

function storeNamespace(env: Env): DoNamespaceLike | undefined {
  return env?.SESSION_STORE as unknown as DoNamespaceLike | undefined;
}

/**
 * Record that `draftId` is owned by the instance identified by
 * `ownerSessionId` (the session identity the draft row was written
 * under). Called by every draft create path immediately after the row
 * insert. Never throws: draft creation must not fail because the
 * routing registry is unreachable — but the failure is logged loud,
 * and a draft whose registration failed will surface again as a loud
 * unmatched settlement if a webhook ever references it.
 */
export async function registerDraftOwner(
  env: Env,
  draftId: string,
  ownerSessionId: string
): Promise<DraftOwnerRegistration> {
  // Issue #2436 (#1976 step 5e): the registration claim is
  // the named ClaimPort's consume contract. When
  // BUCKET_PORTS_ENABLED is on it composes through
  // src/data/createBucketPorts.ts; off, the direct funnel
  // claim below serves, unchanged. The three outcomes are
  // never collapsed: "unavailable" stays a loud routing
  // failure, distinct from "duplicate".
  const key = `${DRAFT_OWNER_KEY_PREFIX}${draftId}`;
  const outcome = isBucketPortsEnabled(env)
    ? await createBucketPorts(env).claims.consume(
        DRAFT_OWNER_NAMESPACE,
        key,
        ownerSessionId
      )
    : await consumeStoreKey({
        namespace: storeNamespace(env),
        namespaceName: DRAFT_OWNER_NAMESPACE,
        key,
        value: ownerSessionId,
      });
  if (outcome === "unavailable") {
    structuredLog.error("payments.draft_owner_registration_unavailable", {
      message:
        `[payments] draft owner registration unavailable for ${draftId}: SessionStore unreachable; ` +
        "a gateway webhook for this draft will be unable to route and will fail loud as unmatched",
      draftId,
    });
    return "unavailable";
  }
  return outcome === "consumed" ? "registered" : "duplicate";
}

/**
 * Resolve the owning instance's session identity for `draftId`, or null
 * when no create path registered it (unknown draft, or a draft created
 * before this registry existed). Never throws.
 */
export async function resolveDraftOwner(env: Env, draftId: string): Promise<string | null> {
  // Issue #2436: flag-on resolves through the residual
  // bucket port's payments bucket; flag-off is the direct
  // funnel composition below. Never throws either way.
  const kv = isBucketPortsEnabled(env)
    ? createBucketPorts(env).bucketKv("payments")
    : createStoreKv({
        namespace: storeNamespace(env),
        namespaceName: DRAFT_OWNER_NAMESPACE,
        legacyFallback: false,
      });
  const value = await kv.get(`${DRAFT_OWNER_KEY_PREFIX}${draftId}`);
  const owner = (value || "").trim();
  return owner ? owner : null;
}
