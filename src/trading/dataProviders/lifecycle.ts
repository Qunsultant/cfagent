/**
 * Issue #1170 (E3 of epic #1116): the data-provider provisioning
 * lifecycle service — the legal-transition layer over the P1
 * provider-config store (providerConfigStore.ts).
 *
 * P1 shipped the store with raw upserts and state setters and the
 * lifecycle STATES as vocabulary; nothing enforced which moves are
 * legal, nothing verified a provider actually works before it could
 * be enabled, and nothing recorded who changed what. This module is
 * that enforcement, in one function:
 *
 *   transitionProvider(sql, providerId, action, actor, deps)
 *
 * THE LEGAL MAP (over ProviderLifecycleState):
 *
 *   register:    (no record)            → registered
 *   configure:   registered | configured → configured
 *   verify:      configured             → verified   (real check, below)
 *   enable:      verified               → enabled
 *                disabled               → enabled   (only with prior
 *                                                     verification evidence)
 *   disable:     enabled                → disabled
 *   deprovision: any state except deprovisioned → deprovisioned (terminal)
 *
 * Every other move throws ProviderLifecycleError (carrying provider,
 * action, from, to) and changes NOTHING. Deprovisioned is terminal
 * in this slice: a deprovisioned provider is re-provisioned by
 * deleting its record out of band, never by a transition.
 *
 * VERIFY IS A REAL CHECK. The caller injects a verifier (the route
 * layer binds etrade's to the adapter's status + conformance and
 * adapter-less providers to an honest failure). A passing verify
 * records evidence — { verifiedAt, summary, verifiedBy } — on the
 * config record (see EVIDENCE below); a failing or throwing
 * verifier leaves the record in "configured" and the rejection
 * carries the verifier's own summary as the reason. Verify with no
 * verifier injected is rejected (verifier_unavailable): the service
 * never marks a provider verified on its own say-so.
 *
 * EVIDENCE LIVES IN THE CONFIG JSON. ProviderConfigRecord has no
 * verifiedAt column, and the smallest honest mechanism is the
 * record's own free-form config object: `config.verification =
 * { verifiedAt, summary, verifiedBy }`. It is written only by a
 * passing verify, read by the disabled → enabled rule (a disabled
 * record written by raw store setters — the pre-E3 world — carries
 * no evidence and cannot be enabled through the lifecycle), and
 * cleared by configure (new configuration invalidates the old
 * verification) and by deprovision.
 *
 * CREDENTIALS ARE REFERENCES ONLY. configure/register accept a
 * credentialRef that must LOOK like a reference name in the forms
 * the codebase already uses — "env:ALPACA_API_KEY" (the deploy-time
 * env var name), "sessionstore:etrade:token" (the SessionStore
 * key), or a bare env-style name ("ALPACA_API_KEY", "ET_API_KEY").
 * Whitespace, dotted/JWT-shaped strings, hex tokens, and lowercase
 * secret-shaped strings are rejected (invalid_credential_ref) and
 * nothing is stored. The value is never logged: audit payloads name
 * the action and states, never the reference.
 *
 * AUDIT. When the caller injects an audit sink, EVERY transition
 * attempt emits exactly one event — accepted or rejected — with
 * actor, provider, action, from → to, outcome, and (on rejection)
 * the reason. The sink is a plain function parameter so this
 * module stays inside the trading boundary: the route layer binds
 * it to the orchestrator's recordAudit owner (#270); the service
 * itself imports no agent code.
 *
 * DEPROVISION side effects: the enabled flag goes off, the
 * provider's capability routes are withdrawn (deleteCapability-
 * RoutesForProvider: primaries deleted, gap-fill slots cleared),
 * the credential reference is cleared, verification evidence is
 * dropped, and the record is tombstoned to "deprovisioned".
 * Captures (mas_data_captures) are history and are NEVER touched.
 *
 * ROUTE TIERS (E5, issue #1202): configure also accepts routeTiers
 * — the minTier for routes this provider serves (either slot; the
 * tier gates the whole route). The assignments are validated as a
 * whole before anything is stored and ride inside the configure's
 * audit event; enforcement lives in the registry (resolveRoute's
 * callerTier), not here.
 */

import type { SqlStorage } from "../../orm";
import {
  DATA_PROVIDER_CAPABILITIES,
  isTier,
  type DataProviderCapability,
  type DataProviderId,
  type Tier,
} from "./contract";
import {
  getCapabilityRoute,
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  upsertCapabilityRoute,
  upsertProviderConfig,
  clearProviderCredentialRef,
  deleteCapabilityRoutesForProvider,
  type CapabilityRouteInput,
  type CapabilityRouteRecord,
  type ProviderConfigInput,
  type ProviderConfigRecord,
  type ProviderLifecycleState,
} from "./providerConfigStore";
import type {
  ProviderConfigStore,
  ProviderConfigWrite,
} from "../../data/providerConfigPorts";
import { FEED_JOB_CODES } from "../../services/feedJobCodes";
import {
  FeedJobTimeoutError,
  FEED_JOB_TIMEOUTS,
  withFeedDeadline,
} from "../../services/feedJobTimeouts";

export type ProviderLifecycleAction =
  | "register"
  | "configure"
  | "verify"
  | "enable"
  | "disable"
  | "deprovision";

export type ProviderLifecycleErrorCode =
  | "illegal_transition"
  | "unknown_provider"
  | "already_registered"
  | "invalid_credential_ref"
  | "invalid_route_tier"
  | "verification_failed"
  | "verifier_unavailable"
  /** #4304 — the verify probe exceeded its named bound. */
  | "FEED_VERIFY_TIMEOUT";

/** A rejected lifecycle move. `from` is null when no record exists. */
export class ProviderLifecycleError extends Error {
  readonly providerId: string;
  readonly action: ProviderLifecycleAction;
  readonly from: ProviderLifecycleState | null;
  readonly to: ProviderLifecycleState | null;
  readonly code: ProviderLifecycleErrorCode;
  constructor(args: {
    providerId: string;
    action: ProviderLifecycleAction;
    from: ProviderLifecycleState | null;
    to: ProviderLifecycleState | null;
    code: ProviderLifecycleErrorCode;
    message: string;
  }) {
    super(args.message);
    this.name = "ProviderLifecycleError";
    this.providerId = args.providerId;
    this.action = args.action;
    this.from = args.from;
    this.to = args.to;
    this.code = args.code;
  }
}

/** The injected real check behind the verify action. */
export interface ProviderVerifyResult {
  ok: boolean;
  /** Human-readable evidence summary; recorded on success, the rejection reason on failure. No payloads, no secrets. */
  summary: string;
}
export type ProviderVerifier = (
  providerId: string
) => Promise<ProviderVerifyResult>;

/** One audit event per transition attempt (accepted or rejected). */
export interface ProviderLifecycleAuditEvent {
  actor: string;
  providerId: string;
  action: ProviderLifecycleAction;
  from: ProviderLifecycleState | null;
  to: ProviderLifecycleState | null;
  outcome: "accepted" | "rejected";
  reason?: string;
  /**
   * Configure only (E5, issue #1202): the route-tier assignments the
   * configure carried, as submitted — present on accepted AND
   * rejected configure events so the audit shows the attempted tier
   * change either way.
   */
  routeTiers?: Partial<Record<DataProviderCapability, Tier>>;
}
export type ProviderLifecycleAuditSink = (
  event: ProviderLifecycleAuditEvent
) => void;

export interface ProviderConfigureInput {
  /** Credential REFERENCE name (validated); null clears the stored reference; undefined keeps it. */
  credentialRef?: string | null;
  displayName?: string;
  /** Free-form provider config merged into the record's config JSON. */
  metadata?: Record<string, unknown>;
  /**
   * Route-tier assignments (E5, issue #1202): for each capability,
   * the minTier of the route this provider serves — in EITHER the
   * primary or the gap-fill slot (the tier gates the whole route).
   * Validated as a whole before anything is stored: an unknown
   * capability, a value that is not a tier, or a capability this
   * provider does not serve rejects the configure
   * (invalid_route_tier) with nothing stored.
   */
  routeTiers?: Partial<Record<DataProviderCapability, Tier>>;
}

export interface ProviderRegisterInput {
  adapterKind?: string;
  precedence?: number;
  credentialRef?: string | null;
  displayName?: string;
}

export interface ProviderTransitionDeps {
  audit?: ProviderLifecycleAuditSink;
  verifier?: ProviderVerifier;
  /**
   * #4304 — the verify probe's bound in milliseconds. The route
   * resolves it from the FEED_JOB_VERIFY_MS knob; any other
   * caller omits it and the lifecycle falls back to the
   * recorded default (FEED_JOB_TIMEOUTS.verifyMs). An invalid
   * value is refused by name by the race guard, never treated
   * as no deadline.
   */
  verifyTimeoutMs?: number;
  configure?: ProviderConfigureInput;
  register?: ProviderRegisterInput;
}

// ---------------------------------------------------------------------------
// Credential reference validation
// ---------------------------------------------------------------------------

const ENV_STYLE_REF = /^[A-Z][A-Z0-9_]{2,}$/;
const ENV_PREFIXED_REF = /^env:[A-Z][A-Z0-9_]{1,}$/;
const SESSIONSTORE_REF =
  /^sessionstore:[A-Za-z0-9][A-Za-z0-9_-]*(:[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * Is `value` a plausible credential REFERENCE name — a pointer to
 * where a secret lives — rather than a secret value? Accepts the
 * forms the codebase already stores ("env:ALPACA_API_KEY",
 * "sessionstore:etrade:token", bare "ALPACA_API_KEY"); rejects
 * anything with whitespace or characters outside [A-Za-z0-9_:-]
 * (dots, slashes, +, = — the shapes of JWTs, URLs, and encoded
 * tokens), hex tokens, and bare lowercase strings (secret-shaped,
 * never reference-shaped). Length-capped so a pasted payload
 * cannot pass as a name.
 */
export function isCredentialReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 128) return false;
  if (/\s/.test(value)) return false;
  if (/^[0-9a-fA-F]{32,}$/.test(value)) return false; // hex token, not a name
  if (ENV_PREFIXED_REF.test(value)) return true;
  if (SESSIONSTORE_REF.test(value)) return true;
  return ENV_STYLE_REF.test(value);
}

// ---------------------------------------------------------------------------
// Verification evidence (config.verification — see the module header)
// ---------------------------------------------------------------------------

export interface ProviderVerificationEvidence {
  verifiedAt: string;
  summary: string;
  verifiedBy: string;
}

export function getVerificationEvidence(
  record: ProviderConfigRecord
): ProviderVerificationEvidence | null {
  const v = (record.config as Record<string, unknown>)?.verification;
  if (
    v &&
    typeof v === "object" &&
    typeof (v as any).verifiedAt === "string" &&
    (v as any).verifiedAt !== ""
  ) {
    return v as ProviderVerificationEvidence;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The transition function
// ---------------------------------------------------------------------------

/** The state a successful action lands in (audit/error reporting). */
function targetStateFor(
  action: ProviderLifecycleAction
): ProviderLifecycleState {
  switch (action) {
    case "register":
      return "registered";
    case "configure":
      return "configured";
    case "verify":
      return "verified";
    case "enable":
      return "enabled";
    case "disable":
      return "disabled";
    case "deprovision":
      return "deprovisioned";
  }
}

function isLegal(
  action: ProviderLifecycleAction,
  record: ProviderConfigRecord | null
): boolean {
  if (action === "register") return record === null;
  if (!record) return false;
  const from = record.lifecycleState;
  switch (action) {
    case "configure":
      return from === "registered" || from === "configured";
    case "verify":
      return from === "configured";
    case "enable":
      return (
        from === "verified" ||
        (from === "disabled" && getVerificationEvidence(record) !== null)
      );
    case "disable":
      return from === "enabled";
    case "deprovision":
      return from !== "deprovisioned";
  }
}

/**
 * The store operations the transition core runs over. Two
 * bindings exist: the legacy SqlStorage surface (sync functions,
 * sequential writes — the behaviour this module has always had)
 * and the ProviderConfigStore port (#2303). The port binding
 * additionally supplies applyWrites, which switches the two
 * multi-write actions (configure, deprovision) to a pre-computed
 * WRITE SET applied as one unit of work through the port's
 * transaction seam (on the D1 adapter: withTransaction's batch
 * leg — the aspect's first production use, ADR 0022 D-C). The
 * sequential path remains the semantics wherever no write-set
 * seam exists; both paths compute identical end states.
 */
type MaybePromise<T> = T | Promise<T>;

interface LifecycleStoreOps {
  get(id: DataProviderId): MaybePromise<ProviderConfigRecord | null>;
  list(): MaybePromise<ProviderConfigRecord[]>;
  upsert(input: ProviderConfigInput): MaybePromise<ProviderConfigRecord>;
  clearRef(id: DataProviderId): MaybePromise<ProviderConfigRecord | null>;
  getRoute(
    capability: DataProviderCapability
  ): MaybePromise<CapabilityRouteRecord | null>;
  upsertRoute(input: CapabilityRouteInput): MaybePromise<CapabilityRouteRecord>;
  listRoutes(): MaybePromise<CapabilityRouteRecord[]>;
  deleteRoutesFor(
    providerId: DataProviderId
  ): MaybePromise<{ deleted: number; gapFillCleared: number }>;
  /** Present only on the port binding: apply a write set atomically. */
  applyWrites?(writes: readonly ProviderConfigWrite[]): Promise<void>;
}

function sqlLifecycleOps(sql: SqlStorage): LifecycleStoreOps {
  return {
    get: (id) => getProviderConfig(sql, id),
    list: () => listProviderConfigs(sql),
    upsert: (input) => upsertProviderConfig(sql, input),
    clearRef: (id) => clearProviderCredentialRef(sql, id),
    getRoute: (capability) => getCapabilityRoute(sql, capability),
    upsertRoute: (input) => upsertCapabilityRoute(sql, input),
    listRoutes: () => listCapabilityRoutes(sql),
    deleteRoutesFor: (id) => deleteCapabilityRoutesForProvider(sql, id),
  };
}

function portLifecycleOps(port: ProviderConfigStore): LifecycleStoreOps {
  return {
    get: (id) => port.getProviderConfig(id),
    list: () => port.listProviderConfigs(),
    upsert: (input) => port.upsertProviderConfig(input),
    clearRef: (id) => port.clearProviderCredentialRef(id),
    getRoute: (capability) => port.getCapabilityRoute(capability),
    upsertRoute: (input) => port.upsertCapabilityRoute(input),
    listRoutes: () => port.listCapabilityRoutes(),
    deleteRoutesFor: (id) => port.deleteCapabilityRoutesForProvider(id),
    applyWrites: (writes) => port.applyConfigWrites(writes),
  };
}

/**
 * Perform one lifecycle transition. Returns the record as stored on
 * success; throws ProviderLifecycleError on any rejection (illegal
 * move, unknown provider, invalid credential reference, failed or
 * unavailable verification) with the store left unchanged. Emits
 * exactly one audit event per attempt when deps.audit is supplied.
 */
export async function transitionProvider(
  sql: SqlStorage,
  providerId: string,
  action: ProviderLifecycleAction,
  actor: string,
  deps: ProviderTransitionDeps = {}
): Promise<ProviderConfigRecord> {
  return transitionProviderCore(sqlLifecycleOps(sql), providerId, action, actor, deps);
}

/**
 * The same transition over the ProviderConfigStore port (#2303):
 * production wiring passes the D1 adapter, so lifecycle reads and
 * writes run on D1, and configure/deprovision apply their write
 * phase as one transactional unit (see LifecycleStoreOps).
 */
export async function transitionProviderViaPort(
  port: ProviderConfigStore,
  providerId: string,
  action: ProviderLifecycleAction,
  actor: string,
  deps: ProviderTransitionDeps = {}
): Promise<ProviderConfigRecord> {
  return transitionProviderCore(portLifecycleOps(port), providerId, action, actor, deps);
}

async function transitionProviderCore(
  ops: LifecycleStoreOps,
  providerId: string,
  action: ProviderLifecycleAction,
  actor: string,
  deps: ProviderTransitionDeps = {}
): Promise<ProviderConfigRecord> {
  const id = providerId as DataProviderId;
  const existing = await ops.get(id);
  const from = existing?.lifecycleState ?? null;
  const to = targetStateFor(action);

  // Configure-with-routeTiers detail for the audit event (E5): set
  // by the configure branch before any outcome is emitted, so both
  // the accepted and the rejected event carry what was attempted.
  let routeTierDetail:
    | Partial<Record<DataProviderCapability, Tier>>
    | undefined;

  const reject = (
    code: ProviderLifecycleErrorCode,
    message: string,
    errFrom: ProviderLifecycleState | null = from,
    errTo: ProviderLifecycleState | null = to
  ): never => {
    deps.audit?.({
      actor,
      providerId,
      action,
      from: errFrom,
      to: errTo,
      outcome: "rejected",
      reason: message,
      ...(routeTierDetail ? { routeTiers: routeTierDetail } : {}),
    });
    throw new ProviderLifecycleError({
      providerId,
      action,
      from: errFrom,
      to: errTo,
      code,
      message,
    });
  };

  const accept = (record: ProviderConfigRecord): ProviderConfigRecord => {
    deps.audit?.({
      actor,
      providerId,
      action,
      from,
      to: record.lifecycleState,
      outcome: "accepted",
      ...(routeTierDetail ? { routeTiers: routeTierDetail } : {}),
    });
    return record;
  };

  // --- register: the only action that creates the record. ---
  if (action === "register") {
    if (existing) {
      reject(
        "already_registered",
        `Provider "${providerId}" is already registered (state "${from}"); register creates a new config record.`
      );
    }
    const input = deps.register ?? {};
    if (
      input.credentialRef !== undefined &&
      input.credentialRef !== null &&
      !isCredentialReference(input.credentialRef)
    ) {
      reject(
        "invalid_credential_ref",
        `credentialRef for provider "${providerId}" is not a reference name (expected a form like "env:NAME", "sessionstore:ns:key", or "NAME"); secret values are never accepted.`
      );
    }
    const precedence =
      input.precedence ??
      (await ops.list()).reduce((max, c) => Math.max(max, c.precedence), 0) + 1;
    const config: Record<string, unknown> = {};
    if (input.displayName !== undefined) config.displayName = input.displayName;
    return accept(
      await ops.upsert({
        id,
        adapterKind: input.adapterKind ?? providerId,
        lifecycleState: "registered",
        enabled: false,
        precedence,
        credentialRef: input.credentialRef ?? null,
        config,
      })
    );
  }

  if (!existing) {
    reject(
      "unknown_provider",
      `No provider config exists for "${providerId}"; register it before applying "${action}".`,
      null,
      null
    );
  }
  const record = existing as ProviderConfigRecord;

  if (!isLegal(action, record)) {
    if (action === "enable" && from === "disabled") {
      reject(
        "illegal_transition",
        `Cannot enable provider "${providerId}" from state "disabled": the record carries no verification evidence (it was never verified through the lifecycle). Verify it first.`
      );
    }
    reject(
      "illegal_transition",
      `Illegal lifecycle transition for provider "${providerId}": "${action}" is not allowed from state "${from}".`
    );
  }

  switch (action) {
    case "configure": {
      const input = deps.configure ?? {};
      if (
        input.credentialRef !== undefined &&
        input.credentialRef !== null &&
        !isCredentialReference(input.credentialRef)
      ) {
        reject(
          "invalid_credential_ref",
          `credentialRef for provider "${providerId}" is not a reference name (expected a form like "env:NAME", "sessionstore:ns:key", or "NAME"); secret values are never accepted.`
        );
      }
      // Route tiers (E5): validated as a whole BEFORE anything is
      // stored — an invalid assignment rejects the configure with
      // the record and every route untouched.
      if (input.routeTiers) routeTierDetail = input.routeTiers;
      const routeTierWrites: Array<{
        capability: DataProviderCapability;
        tier: Tier;
        route: CapabilityRouteRecord;
      }> = [];
      for (const [capabilityRaw, tierRaw] of Object.entries(
        input.routeTiers ?? {}
      )) {
        if (
          !(DATA_PROVIDER_CAPABILITIES as readonly string[]).includes(
            capabilityRaw
          )
        ) {
          reject(
            "invalid_route_tier",
            `routeTiers for provider "${providerId}" names unknown capability "${capabilityRaw}"; known capabilities are ${DATA_PROVIDER_CAPABILITIES.join(", ")}.`
          );
        }
        if (!isTier(tierRaw)) {
          reject(
            "invalid_route_tier",
            `routeTiers.${capabilityRaw} for provider "${providerId}" is not a tier (expected "freemium" or "premium").`
          );
        }
        const capability = capabilityRaw as DataProviderCapability;
        const route = await ops.getRoute(capability);
        if (
          route &&
          (route.primaryProviderId === id || route.gapFillProviderId === id)
        ) {
          routeTierWrites.push({ capability, tier: tierRaw, route });
        } else {
          reject(
            "invalid_route_tier",
            `Provider "${providerId}" does not serve capability "${capability}" as primary or gap-fill; there is no route of this provider to tier.`
          );
        }
      }
      const config: Record<string, unknown> = { ...record.config };
      // A new configuration invalidates any earlier verification.
      delete config.verification;
      if (input.metadata) {
        for (const [k, v] of Object.entries(input.metadata)) config[k] = v;
      }
      if (input.displayName !== undefined) config.displayName = input.displayName;

      if (ops.applyWrites) {
        // Write-set path (port binding): the config row and every
        // route-tier row are computed from the reads above and
        // applied as ONE unit of work. An explicit-null
        // credentialRef clears the reference inside the same unit
        // (the sequential path's upsert-then-clear end state).
        const now = new Date().toISOString();
        const finalRow: ProviderConfigRecord = {
          ...record,
          lifecycleState: "configured",
          config,
          credentialRef:
            input.credentialRef === null
              ? null
              : (input.credentialRef ?? record.credentialRef),
          updatedAt: now,
        };
        const writes: ProviderConfigWrite[] = [
          { kind: "upsertProvider", record: finalRow },
          ...routeTierWrites.map(
            (write): ProviderConfigWrite => ({
              kind: "upsertRoute",
              record: {
                ...write.route,
                minTier: write.tier,
                updatedAt: now,
              },
            })
          ),
        ];
        await ops.applyWrites(writes);
        return accept((await ops.get(id)) ?? finalRow);
      }

      const updated = await ops.upsert({
        id,
        adapterKind: record.adapterKind,
        precedence: record.precedence,
        lifecycleState: "configured",
        enabled: record.enabled,
        ...(input.credentialRef !== undefined
          ? { credentialRef: input.credentialRef }
          : {}),
        config,
      });
      // upsert's merge rule keeps the old reference on null input;
      // an explicit null means CLEAR.
      const final =
        input.credentialRef === null
          ? ((await ops.clearRef(id)) ?? updated)
          : updated;
      // Apply the validated route tiers (slots re-read at apply
      // time; occupancy was proven above and nothing else writes
      // routes during a transition).
      for (const write of routeTierWrites) {
        const route = await ops.getRoute(write.capability);
        if (route) {
          await ops.upsertRoute({
            capability: write.capability,
            primaryProviderId: route.primaryProviderId,
            gapFillProviderId: route.gapFillProviderId,
            minTier: write.tier,
          });
        }
      }
      return accept(final);
    }

    case "verify": {
      if (!deps.verifier) {
        reject(
          "verifier_unavailable",
          `No verifier is available for provider "${providerId}"; a provider is never marked verified without a real check.`
        );
      }
      // #4304 — the probe is raced against the named verify bound
      // (FEED_JOB_VERIFY_MS, 120s default): a hung probe settles
      // with FEED_VERIFY_TIMEOUT instead of sitting forever. The
      // race is created OUTSIDE the try so an invalid bound is
      // refused by name (withFeedDeadline's guard throws
      // synchronously) instead of being misread as a verifier
      // failure; the verifier is an async function, so calling it
      // cannot throw synchronously. A timeout rejection is NOT
      // folded into "verifier threw" — it carries the stable
      // code, so the route response and the async-job record name
      // the timeout exactly.
      const verifyMs = deps.verifyTimeoutMs ?? FEED_JOB_TIMEOUTS.verifyMs;
      const raced = withFeedDeadline(
        (deps.verifier as ProviderVerifier)(providerId),
        verifyMs,
        FEED_JOB_CODES.verifyTimeout,
      );
      let result: ProviderVerifyResult;
      try {
        result = await raced;
      } catch (err) {
        if (err instanceof FeedJobTimeoutError) {
          reject(
            "FEED_VERIFY_TIMEOUT",
            `Verification timed out for provider "${providerId}" after ${verifyMs}ms (${FEED_JOB_CODES.verifyTimeout}).`,
          );
        }
        result = {
          ok: false,
          summary: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!result.ok) {
        reject(
          "verification_failed",
          `Verification failed for provider "${providerId}": ${result.summary}`
        );
      }
      const config: Record<string, unknown> = {
        ...record.config,
        verification: {
          verifiedAt: new Date().toISOString(),
          summary: result.summary,
          verifiedBy: actor,
        } satisfies ProviderVerificationEvidence,
      };
      return accept(
        await ops.upsert({
          id,
          adapterKind: record.adapterKind,
          precedence: record.precedence,
          lifecycleState: "verified",
          enabled: record.enabled,
          credentialRef: record.credentialRef,
          config,
        })
      );
    }

    case "enable": {
      return accept(
        await ops.upsert({
          id,
          adapterKind: record.adapterKind,
          precedence: record.precedence,
          lifecycleState: "enabled",
          enabled: true,
          credentialRef: record.credentialRef,
          config: record.config,
        })
      );
    }

    case "disable": {
      return accept(
        await ops.upsert({
          id,
          adapterKind: record.adapterKind,
          precedence: record.precedence,
          lifecycleState: "disabled",
          enabled: false,
          credentialRef: record.credentialRef,
          config: record.config,
        })
      );
    }

    case "deprovision": {
      const config: Record<string, unknown> = { ...record.config };
      delete config.verification;
      if (ops.applyWrites) {
        // Write-set path (port binding): route withdrawals, the
        // tombstone and the credential-ref clear land as ONE unit
        // of work — a deprovision can no longer half-apply (routes
        // gone but the record live, or the tombstone retaining a
        // credential pointer it no longer owns).
        const now = new Date().toISOString();
        const writes: ProviderConfigWrite[] = [];
        for (const route of await ops.listRoutes()) {
          if (route.primaryProviderId === id) {
            writes.push({ kind: "deleteRoute", capability: route.capability });
          } else if (route.gapFillProviderId === id) {
            writes.push({
              kind: "upsertRoute",
              record: { ...route, gapFillProviderId: null, updatedAt: now },
            });
          }
        }
        const tombstone: ProviderConfigRecord = {
          ...record,
          lifecycleState: "deprovisioned",
          enabled: false,
          credentialRef: null,
          config,
          updatedAt: now,
        };
        writes.push({ kind: "upsertProvider", record: tombstone });
        await ops.applyWrites(writes);
        return accept((await ops.get(id)) ?? tombstone);
      }
      await ops.deleteRoutesFor(id);
      const tombstoned = await ops.upsert({
        id,
        adapterKind: record.adapterKind,
        precedence: record.precedence,
        lifecycleState: "deprovisioned",
        enabled: false,
        credentialRef: record.credentialRef,
        config,
      });
      const cleared = (await ops.clearRef(id)) ?? tombstoned;
      return accept(cleared);
    }
  }
}
