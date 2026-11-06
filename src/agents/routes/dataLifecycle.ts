/**
 * Admin data lifecycle routes — issue #3250 (#1976 scope
 * addition): clean-state reset, platform bootstrap, and tenant
 * bootstrap as coherent preview → confirm → audit operations in
 * the Platform Admin neighbourhood.
 *
 *   POST /api/data-lifecycle/clean-state        preview / confirm
 *   GET  /api/data-lifecycle/export             pre-wipe bundle
 *   GET  /api/data-lifecycle/bootstrap          platform check
 *   POST /api/data-lifecycle/bootstrap          platform initialize
 *   POST /api/data-lifecycle/tenant-bootstrap   preview / confirm
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding.)
 *
 * GATES — layered from the existing idioms, widest blast radius
 * first:
 * - Every route: the platformTenants operator gate (effective
 *   operators = env COMMERCIAL_STORE_OPERATORS ∪ the store
 *   operators list; no login 401, non-operator 403, unbound
 *   tenant stores 503 where the operation needs them). This is
 *   the gate of the panel neighbourhood the section lives in,
 *   and it works pre-genesis (env-held), which the bootstrap
 *   operations require.
 * - Platform clean state ADDITIONALLY requires a live
 *   platform-admin membership (the kvWipe #2489 resolveCaller
 *   idiom): it wipes platform-wide identity state — the same
 *   blast radius kvWipe gates that way.
 * - The tenant-genesis claim (tenant bootstrap with
 *   claimGenesis) ADDITIONALLY requires platform-admin: Slice 3's
 *   hard rule is that platform privileges require a platform-
 *   admin granter, and the claim mints a platform-admin.
 *
 * PREVIEW → CONFIRM BINDING: a preview deletes nothing, writes
 * no audit, and returns a previewToken — a SHA-256 over the
 * canonical enumeration (scope + tenant + per-target counts).
 * A confirm must present the token of a preview of the same
 * scope; the server recomputes the enumeration and refuses
 * (409) when the token is absent or stale. A raw confirm can
 * therefore never skip the preview the operator saw, and a
 * scope that changed since the preview must be re-previewed.
 * Platform scope additionally requires the typed confirmation
 * confirmText: "CLEAN PLATFORM" and auditConfirm: true (the
 * mas_events second-confirmation precedent, #2489); tenant
 * scope requires auditConfirm: true because its instance set
 * includes mas_events.
 *
 * CLEAN-STATE DEFINITIONS — enumerated in code below
 * (TENANT_CLEAN_TARGETS / PLATFORM_CLEAN_TARGETS), never
 * free-form input. What a clean state deliberately EXCLUDES,
 * with reasons:
 * - The IAAA audit chain in tenant scope: the chain is one
 *   platform-global hash chain (#1760); its segments mix
 *   tenants and cannot be tenant-scoped. Platform scope DOES
 *   clear the segments — and the operation's own AuditLog
 *   record is appended after, as the fresh chain's surviving
 *   event (the mas_events clear idiom, one level up).
 * - D1 directory / commercial / channel records: the tenant
 *   system of record. No existing wipe tool deletes them
 *   either (maintenance, kvWipe, queue wipe all leave them);
 *   the tenant row and its settings survive a clean state so
 *   the tenant remains administrable and re-bootstrappable.
 * - Claim buckets (payments / slack link claims): replay-guard
 *   safety state; wiping them re-opens replay windows. kvWipe
 *   excludes them for the same reason.
 * - mas_messages: per-session purge only (POST /clear), as in
 *   the maintenance route.
 * Instances are per-login, not per-tenant (the #2457 topology):
 * a member of two tenants shares one instance, and clearing it
 * under one tenant's clean state affects that login's instance
 * state as a whole. The fan-out targets ONLY the named tenant's
 * resolved logins; per-login results disclose exactly which
 * instances were touched.
 *
 * AUDIT: every confirmed operation audits AFTER its writes,
 * through both the orchestrator funnel (ctx.audit — the
 * mas_events idiom of the neighbouring routes) and the AuditLog
 * port via recordAuditEvent over the wired store
 * (createWiredAuditStore — the step-5d family, flag-respecting).
 * An AuditLog failure is reported in the response as
 * audit.auditLog.ok = false; the operation is never reported as
 * audited when it was not (recordAuditEvent semantics).
 * AuditLog outcome: "succeeded" when the operation completed in
 * full, "failed" when it completed partially (the enum has no
 * partial value; per-step truth lives in the response and in
 * the funnel payload).
 *
 * BOOTSTRAP ELEMENTS / STEPS are defined from codebase evidence;
 * each names its source of truth inline. Nothing here invents
 * identity: an unresolvable founding admin is reported missing,
 * never provisioned (the iaaaBootstrap rule).
 *
 * #CDO-mha7
 */

import { IAAA_AUDIT_KEY_PREFIX } from "../../data/auditLogPorts";
import { createKvWipeStores } from "./kvWipe";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import { createTenantDirectoryAdapter } from "../../data/createTenantDirectoryPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import { createTenantChannelAdapter } from "../../data/createTenantChannelPorts";
import type {
  TenantChannelStore,
  TenantChannelConfig,
} from "../../data/tenantChannelPorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import {
  IAAA_MEMBERSHIP_KEY_PREFIX,
  createKvMembershipStore,
  listMembershipsFromEntries,
} from "../../security/iaaaMembershipStore";
import {
  createMembership,
  type Membership,
  type MembershipStore,
} from "../../security/authorization";
import { provisionBootstrapAdmins } from "../../security/iaaaBootstrap";
import {
  parseBootstrapListWithGenesis,
  platformGenesisMarkerKey,
  resolveIaaaTenant,
} from "../../security/iaaaGithubEndToEnd";
import { createKvBindingStore } from "../../security/iaaaLogin";
import { getInternalUserId } from "../../security/identityBinding";
import {
  lookupInternalUserIdByLogin,
  lookupLoginByUserId,
} from "../../security/iaaaMigration";
import { isPlatformAdmin } from "../../security/iaaaAdminOverview";
import { isLoginShaped } from "../../security/serviceIdentity";
import { sessionStore } from "../../security/session";
import {
  isTenantIdShaped,
  listTenantIds,
  resolveTenantLogins,
  tenantMemberIds,
} from "../../security/tenantQueueMapping";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  type AuditStore,
} from "../../security/iaaaAudit";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { SESSION_STORE_SCHEMA_VERSION } from "../../security/sessionStore";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";

// ---------------------------------------------------------------------------
// Context + seams
// ---------------------------------------------------------------------------

/** List/get/put/delete seams over the SessionStore namespaces (kvWipe idiom). */
export interface DataLifecycleKvStores {
  listSessions(prefix: string): Promise<Array<{ key: string; value: string }> | null>;
  getSessionKey(key: string): Promise<string | null>;
  putSessionKey(key: string, value: string): Promise<void>;
  deleteSessionKey(key: string): Promise<void>;
  listEtrade(prefix: string): Promise<Array<{ key: string }> | null>;
  deleteEtradeKey(key: string): Promise<void>;
}

/**
 * Production stores composition. The durableKv funnel's
 * route-level composition is pinned by the D-D census
 * (tests/global_dd_census_2356.test.ts) to exactly one admin
 * surface — kvWipe's builder — so this module composes THAT
 * builder instead of calling the funnel itself: listings come
 * from createKvWipeStores, values are read back per key through
 * its getSessionKey, and puts go through the session store (the
 * step-5b façade). No new funnel call sites, no new allow-list
 * entries.
 */
export function createDataLifecycleKvStores(env: Env): DataLifecycleKvStores {
  const base = createKvWipeStores(env);
  const sessionsKv = sessionStore(env);
  return {
    listSessions: async (prefix) => {
      const keys = await base.listSessions(prefix);
      if (keys === null) return null;
      const entries: Array<{ key: string; value: string }> = [];
      for (const { key } of keys) {
        const value = await base.getSessionKey(key);
        // A key that vanished between list and get is skipped;
        // the verify-after-delete re-list is the authority.
        if (value !== null) entries.push({ key, value });
      }
      return entries;
    },
    getSessionKey: (key) => base.getSessionKey(key),
    putSessionKey: (key, value) => sessionsKv.put(key, value),
    deleteSessionKey: (key) => base.deleteSessionKey(key),
    listEtrade: (prefix) => base.listEtrade(prefix),
    deleteEtradeKey: (key) => base.deleteEtradeKey(key),
  };
}

export interface DataLifecycleRouteContext {
  /** Worker env (SESSION_STORE, AGENT_DB, COMMERCIAL_STORE_OPERATORS, IAAA_*). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: commercial store (default: AGENT_DB adapter). */
  commercial?: CommercialStore | null;
  /** Test seam: tenant directory (default: AGENT_DB adapter). */
  directory?: TenantDirectory | null;
  /** Test seam: tenant channels (default: AGENT_DB adapter). */
  channels?: TenantChannelStore | null;
  /** Test seam: store operators list (default: AGENT_DB adapter). */
  operators?: Pick<StoreOperators, "listOperators"> | null;
  /** Test seam: sessions-namespace KV for aliases + the membership store. */
  kv?: KvLike;
  /** Test seam: membership store (default: KV store over kv). */
  membershipStore?: MembershipStore;
  /** Test seam: namespace list/delete stores (default: SessionStore builder). */
  stores?: DataLifecycleKvStores;
  /** Test seam: AuditLog store (default: createWiredAuditStore(env)). */
  auditStore?: AuditStore;
  /** Test seam: per-login instance stub (default: ORCHESTRATOR_AGENT addressing). */
  fetchInstance?: (
    login: string,
  ) => { fetch(req: Request): Promise<Response> } | null;
  /** Test seam: IAAA tenant (default: resolveIaaaTenant(env)). */
  iaaaTenantId?: string;
  /** Test seam: clock. */
  nowMs?: () => number;
}

interface ResolvedStores {
  commercial: CommercialStore | null;
  directory: TenantDirectory | null;
  channels: TenantChannelStore | null;
  kv: KvLike;
  membershipStore: MembershipStore;
  stores: DataLifecycleKvStores;
  auditStore: AuditStore;
  iaaaTenantId: string;
  nowMs: () => number;
}

function resolveStores(ctx: DataLifecycleRouteContext): ResolvedStores {
  const kv = ctx.kv ?? sessionStore(ctx.env);
  return {
    commercial:
      ctx.commercial !== undefined
        ? ctx.commercial
        : createCommercialAdapter(ctx.env),
    directory:
      ctx.directory !== undefined
        ? ctx.directory
        : createTenantDirectoryAdapter(ctx.env),
    channels:
      ctx.channels !== undefined
        ? ctx.channels
        : createTenantChannelAdapter(ctx.env),
    kv,
    membershipStore: ctx.membershipStore ?? createKvMembershipStore(kv),
    stores: ctx.stores ?? createDataLifecycleKvStores(ctx.env),
    auditStore: ctx.auditStore ?? createWiredAuditStore(ctx.env),
    iaaaTenantId: ctx.iaaaTenantId ?? resolveIaaaTenant(ctx.env),
    nowMs: ctx.nowMs ?? (() => Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function parseEnvOperators(env: Env): Set<string> {
  const raw = (env as unknown as Record<string, unknown>)[
    "COMMERCIAL_STORE_OPERATORS"
  ];
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** The platformTenants operator gate, verbatim in behaviour. */
async function resolveOperator(
  request: Request,
  ctx: DataLifecycleRouteContext,
): Promise<string | Response> {
  const login = request.headers.get("x-user-login")?.trim() ?? "";
  if (!login) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const effective = parseEnvOperators(ctx.env);
  const adapter =
    ctx.operators !== undefined
      ? ctx.operators
      : createStoreOperatorsAdapter(ctx.env);
  if (adapter) {
    try {
      for (const entry of await adapter.listOperators()) {
        effective.add(entry.login);
      }
    } catch {
      // Degrades to env-only, exactly as the tenant-admin routes.
    }
  }
  if (!effective.has(login)) {
    return jsonError(
      "Forbidden: data lifecycle operations require a store operator.",
      403,
    );
  }
  return login;
}

interface WiredCaller {
  login: string;
  internalUserId: string | null;
  isPlatformAdmin: boolean;
}

/**
 * The kvWipe wired-caller resolution, softened: identity and
 * platform-admin status are computed without failing the request,
 * because some operations need them only for a sub-step. Callers
 * that REQUIRE platform-admin check the flag themselves.
 */
async function resolveWiredCaller(
  request: Request,
  stores: ResolvedStores,
): Promise<WiredCaller> {
  const login = request.headers.get("x-user-login")?.trim() ?? "";
  if (!isLoginShaped(login)) return { login, internalUserId: null, isPlatformAdmin: false };
  const internalUserId = await lookupInternalUserIdByLogin(stores.kv, login);
  if (!internalUserId) return { login, internalUserId: null, isPlatformAdmin: false };
  const memberships = await stores.membershipStore.getMembershipsByUser(internalUserId);
  return {
    login,
    internalUserId,
    isPlatformAdmin: isPlatformAdmin(memberships, stores.nowMs()),
  };
}

// ---------------------------------------------------------------------------
// Clean-state definitions (enumerated; pinned by tests)
// ---------------------------------------------------------------------------

export interface CleanTargetDef {
  id: string;
  label: string;
  kind: "instance" | "kv";
}

export const TENANT_CLEAN_TARGETS: readonly CleanTargetDef[] = [
  { id: "instance-queues", label: "Framework queues of the tenant's member instances", kind: "instance" },
  { id: "instance-tables", label: "Maintenance tables of the tenant's member instances", kind: "instance" },
  { id: "tenant-memberships", label: "The tenant's IAAA membership records", kind: "kv" },
  { id: "tenant-genesis-marker", label: "The tenant's platform-genesis marker", kind: "kv" },
  { id: "tenant-sessions", label: "Session records of the tenant's members", kind: "kv" },
] as const;

export const PLATFORM_CLEAN_TARGETS: readonly CleanTargetDef[] = [
  { id: "instance-queues", label: "Framework queues of every member instance", kind: "instance" },
  { id: "instance-tables", label: "Maintenance tables of every member instance", kind: "instance" },
  { id: "platform-memberships", label: "All IAAA membership records", kind: "kv" },
  { id: "platform-bindings", label: "All identity bindings and login aliases", kind: "kv" },
  { id: "platform-genesis-markers", label: "All tenants' platform-genesis markers", kind: "kv" },
  { id: "platform-tokens", label: "All broker token records", kind: "kv" },
  { id: "platform-audit-log", label: "The IAAA audit log segments", kind: "kv" },
  { id: "platform-sessions", label: "All session records", kind: "kv" },
] as const;

/** The instance tables a clean state clears (the maintenance allowlist minus messages/queue, which have their own targets). */
const INSTANCE_CLEAR_TABLES = [
  "mas_async_jobs",
  "mas_job_outcomes",
  "mas_job_outcomes_meta",
  "mas_events",
] as const;

// ---------------------------------------------------------------------------
// Enumeration plans
// ---------------------------------------------------------------------------

interface KvPlan {
  targetId: string;
  /** Keys counted in the preview for this target. */
  count: number;
  /** Execute the clear; returns the verified deleted count. */
  execute(): Promise<number>;
}

interface InstancePlan {
  logins: string[];
  /** Per-login preview counts for one instance target kind. */
  previewQueues: Map<string, number>;
  previewTables: Map<string, number>;
  queueErrors: Map<string, string>;
  tableErrors: Map<string, string>;
}

function parseMembershipValue(raw: string): Membership | null {
  try {
    const parsed = JSON.parse(raw) as Membership;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.tenantId !== "string" ||
      typeof parsed.internalUserId !== "string" ||
      typeof parsed.membershipId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Membership clear plan for one tenant (or the whole platform
 * when tenantId is null): records in scope + per-user index
 * repair, verified by re-listing (the kvWipe idiom).
 */
async function membershipPlan(
  stores: ResolvedStores,
  tenantId: string | null,
): Promise<KvPlan | null> {
  const entries = await stores.stores.listSessions(IAAA_MEMBERSHIP_KEY_PREFIX);
  if (entries === null) return null;
  const records = entries.filter(
    (e) => !e.key.startsWith(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:`),
  );
  const inScope: Array<{ key: string; membership: Membership | null }> = [];
  for (const entry of records) {
    const membership = parseMembershipValue(entry.value);
    if (tenantId === null) {
      // Platform scope takes every record, parseable or not: the
      // scope is the whole prefix, not a tenant filter.
      inScope.push({ key: entry.key, membership });
    } else if (membership && membership.tenantId === tenantId) {
      // Tenant scope takes only records PROVEN to belong to the
      // tenant; an unparseable record is never claimed.
      inScope.push({ key: entry.key, membership });
    }
  }
  const doomedIds = new Set(
    inScope
      .map((r) => r.membership?.membershipId)
      .filter((id): id is string => typeof id === "string"),
  );
  const affectedUsers = new Set(
    inScope
      .map((r) => r.membership?.internalUserId)
      .filter((id): id is string => typeof id === "string"),
  );
  return {
    targetId: tenantId === null ? "platform-memberships" : "tenant-memberships",
    count: inScope.length,
    async execute() {
      for (const record of inScope) {
        await stores.stores.deleteSessionKey(record.key);
      }
      // Index repair: drop the deleted ids from each affected
      // user's index (delete the index key when it empties), so
      // no stale id survives pointing at a deleted record.
      for (const userId of affectedUsers) {
        const indexKey = `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${userId}`;
        const raw = await stores.stores.getSessionKey(indexKey);
        if (raw === null) continue;
        let ids: string[] = [];
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            ids = parsed.filter((x): x is string => typeof x === "string");
          }
        } catch {
          ids = [];
        }
        const kept = ids.filter((id) => !doomedIds.has(id));
        if (kept.length === 0) {
          await stores.stores.deleteSessionKey(indexKey);
        } else if (kept.length !== ids.length) {
          await stores.stores.putSessionKey(indexKey, JSON.stringify(kept));
        }
      }
      if (tenantId === null) {
        // Platform scope also removes every index key, including
        // indexes whose records were unparseable.
        const remaining = await stores.stores.listSessions(
          IAAA_MEMBERSHIP_KEY_PREFIX,
        );
        if (remaining === null) return inScope.length;
        for (const entry of remaining) {
          await stores.stores.deleteSessionKey(entry.key);
        }
        const verify = await stores.stores.listSessions(
          IAAA_MEMBERSHIP_KEY_PREFIX,
        );
        if (verify === null) return inScope.length;
        return inScope.length - countRemainingRecords(verify, null);
      }
      const verify = await stores.stores.listSessions(
        IAAA_MEMBERSHIP_KEY_PREFIX,
      );
      if (verify === null) return inScope.length;
      return inScope.length - countRemainingRecords(verify, tenantId);
    },
  };
}

function countRemainingRecords(
  entries: Array<{ key: string; value: string }>,
  tenantId: string | null,
): number {
  let n = 0;
  for (const entry of entries) {
    if (entry.key.startsWith(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:`)) continue;
    if (tenantId === null) {
      n += 1;
      continue;
    }
    const membership = parseMembershipValue(entry.value);
    if (membership && membership.tenantId === tenantId) n += 1;
  }
  return n;
}

/** Prefix clear plan (bindings / markers / tokens / audit segments). */
async function prefixPlan(
  stores: ResolvedStores,
  targetId: string,
  namespace: "sessions" | "etrade",
  prefixes: string[],
): Promise<KvPlan | null> {
  const list =
    namespace === "sessions"
      ? (p: string) => stores.stores.listSessions(p)
      : (p: string) => stores.stores.listEtrade(p);
  const del =
    namespace === "sessions"
      ? (k: string) => stores.stores.deleteSessionKey(k)
      : (k: string) => stores.stores.deleteEtradeKey(k);
  const collect = async (): Promise<string[] | null> => {
    const keys: string[] = [];
    for (const prefix of prefixes) {
      const entries = await list(prefix);
      if (entries === null) return null;
      for (const entry of entries) keys.push(entry.key);
    }
    return keys;
  };
  const keys = await collect().catch(() => null);
  if (keys === null) return null;
  return {
    targetId,
    count: keys.length,
    async execute() {
      for (const key of keys) await del(key);
      const remaining = await collect().catch(() => null);
      if (remaining === null) return keys.length;
      return keys.length - remaining.length;
    },
  };
}

/** Single-key plan (one tenant's genesis marker). */
async function markerPlan(
  stores: ResolvedStores,
  tenantId: string,
): Promise<KvPlan> {
  const key = platformGenesisMarkerKey(tenantId);
  const value = await stores.stores.getSessionKey(key);
  return {
    targetId: "tenant-genesis-marker",
    count: value === null ? 0 : 1,
    async execute() {
      if (value === null) return 0;
      await stores.stores.deleteSessionKey(key);
      const after = await stores.stores.getSessionKey(key);
      return after === null ? 1 : 0;
    },
  };
}

/**
 * Session clear plan. Platform: every non-iaaa- key (session
 * records are bare UUID keys; kvWipe's rule). Tenant: only
 * records proven to belong to the tenant's members (parsed
 * internalUserId or githubLogin match) — an unparseable record
 * is never claimed by a tenant scope.
 */
async function sessionsPlan(
  stores: ResolvedStores,
  tenantId: string | null,
  memberIds: Set<string>,
  logins: Set<string>,
): Promise<KvPlan | null> {
  const all = await stores.stores.listSessions("");
  if (all === null) return null;
  const sessionEntries = all.filter((e) => !e.key.startsWith("iaaa-"));
  const matches = (entry: { key: string; value: string }): boolean => {
    if (tenantId === null) return true;
    try {
      const parsed = JSON.parse(entry.value) as {
        internalUserId?: unknown;
        githubLogin?: unknown;
      };
      if (
        typeof parsed.internalUserId === "string" &&
        memberIds.has(parsed.internalUserId)
      ) {
        return true;
      }
      if (
        typeof parsed.githubLogin === "string" &&
        logins.has(parsed.githubLogin)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };
  const keys = sessionEntries.filter(matches).map((e) => e.key);
  return {
    targetId: tenantId === null ? "platform-sessions" : "tenant-sessions",
    count: keys.length,
    async execute() {
      for (const key of keys) await stores.stores.deleteSessionKey(key);
      const verify = await stores.stores.listSessions("");
      if (verify === null) return keys.length;
      const remaining = verify
        .filter((e) => !e.key.startsWith("iaaa-"))
        .filter(matches)
        .length;
      return keys.length - remaining;
    },
  };
}

// ---------------------------------------------------------------------------
// Instance fan-out (the #2457 mechanism)
// ---------------------------------------------------------------------------

interface InstanceStub {
  fetch(req: Request): Promise<Response>;
}

function defaultInstanceStub(
  ctx: DataLifecycleRouteContext,
  login: string,
): InstanceStub | null {
  if (ctx.fetchInstance) return ctx.fetchInstance(login);
  const ns = (
    ctx.env as unknown as {
      ORCHESTRATOR_AGENT?: {
        idFromName(name: string): unknown;
        get(id: unknown): InstanceStub;
      };
    }
  ).ORCHESTRATOR_AGENT;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    return null;
  }
  return ns.get(ns.idFromName(login));
}

async function forward(
  stub: InstanceStub,
  targetPath: string,
  init: RequestInit,
  targetLogin: string,
  adminLogin: string,
  tenantId: string | null,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; error?: string }> {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("Content-Type", "application/json");
  headers.set("x-user-login", targetLogin);
  headers.set("x-admin-actor", adminLogin);
  if (tenantId) headers.set("x-admin-tenant", tenantId);
  try {
    const res = await stub.fetch(
      new Request(new URL(targetPath, "https://agent.internal"), {
        ...init,
        headers,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      error: err instanceof Error ? err.message : "instance unreachable",
    };
  }
}

function bodyError(body: Record<string, unknown>, status: number): string {
  return typeof body.error === "string" ? body.error : `instance answered ${status}`;
}

/** Preview (or execute) the two instance targets over a login set. */
async function runInstanceTargets(
  ctx: DataLifecycleRouteContext,
  adminLogin: string,
  tenantId: string | null,
  logins: string[],
  confirm: boolean,
): Promise<{
  queues: Array<{ login: string; count: number; error?: string }>;
  tables: Array<{ login: string; count: number; error?: string }>;
}> {
  const queues: Array<{ login: string; count: number; error?: string }> = [];
  const tables: Array<{ login: string; count: number; error?: string }> = [];
  for (const login of logins) {
    const stub = defaultInstanceStub(ctx, login);
    if (!stub) {
      queues.push({ login, count: 0, error: "instance unavailable" });
      tables.push({ login, count: 0, error: "instance unavailable" });
      continue;
    }
    const queueRes = await forward(
      stub,
      "/schedules/cancel-all",
      { method: "POST", body: JSON.stringify(confirm ? { confirm: true } : {}) },
      login,
      adminLogin,
      tenantId,
    );
    if (!queueRes.ok) {
      queues.push({ login, count: 0, error: queueRes.error ?? bodyError(queueRes.body, queueRes.status) });
    } else {
      const n = confirm
        ? Number(queueRes.body.cancelled ?? 0)
        : Number(queueRes.body.wouldCancelCount ?? 0);
      queues.push({ login, count: Number.isFinite(n) ? n : 0 });
    }
    let tableCount = 0;
    let tableError: string | undefined;
    for (const table of INSTANCE_CLEAR_TABLES) {
      const body: Record<string, unknown> = { table };
      if (confirm) {
        body.confirm = true;
        if (table === "mas_events") body.auditConfirm = true;
      }
      const res = await forward(
        stub,
        "/maintenance/clear-table",
        { method: "POST", body: JSON.stringify(body) },
        login,
        adminLogin,
        tenantId,
      );
      if (!res.ok) {
        tableError = res.error ?? bodyError(res.body, res.status);
        break;
      }
      const n = Number(confirm ? res.body.deleted ?? 0 : res.body.wouldDelete ?? 0);
      tableCount += Number.isFinite(n) ? n : 0;
    }
    tables.push({
      login,
      count: tableCount,
      ...(tableError ? { error: tableError } : {}),
    });
  }
  return { queues, tables };
}

// ---------------------------------------------------------------------------
// Audit (after the writes, both funnels)
// ---------------------------------------------------------------------------

async function auditOperation(
  ctx: DataLifecycleRouteContext,
  stores: ResolvedStores,
  input: {
    action: string;
    tenantId: string;
    actorLogin: string;
    actorInternalUserId: string | null;
    succeeded: boolean;
    funnelPayload: Record<string, unknown>;
  },
): Promise<{ funnel: true; auditLog: { ok: boolean; error?: string } }> {
  ctx.audit(input.action, "orchestrator", {
    ...input.funnelPayload,
    actorLogin: input.actorLogin,
  });
  const result = await recordAuditEvent(stores.auditStore, {
    timestamp: stores.nowMs(),
    type: "data-lifecycle",
    actorPrincipalId: input.actorInternalUserId ?? input.actorLogin,
    actorType: "human",
    initiatingPrincipalId: input.actorInternalUserId ?? input.actorLogin,
    tenantId: input.tenantId,
    correlationId: crypto.randomUUID(),
    action: input.action,
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: input.succeeded ? "succeeded" : "failed",
  });
  return {
    funnel: true,
    auditLog: result.ok
      ? { ok: true }
      : { ok: false, error: result.error },
  };
}

// ---------------------------------------------------------------------------
// Clean state: enumeration, preview, confirm
// ---------------------------------------------------------------------------

const GENESIS_MARKER_PREFIX = platformGenesisMarkerKey("");
const AUDIT_EXPORT_CAP = 5000;

interface TargetReport {
  id: string;
  label: string;
  kind: string;
  count?: number;
  deleted?: number;
  verified?: boolean;
  error?: string;
  perLogin?: Array<{
    login: string;
    count?: number;
    deleted?: number;
    error?: string;
  }>;
}

interface Enumeration {
  targets: TargetReport[];
  kvPlans: Map<string, KvPlan>;
  logins: string[];
  previewToken: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function previewTokenFor(
  scope: "tenant" | "platform",
  tenantId: string | null,
  targets: TargetReport[],
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      scope,
      tenantId,
      targets: targets.map((t) => [t.id, t.count ?? null]),
    }),
  );
}

async function allMemberships(stores: ResolvedStores): Promise<Membership[]> {
  const entries = await stores.stores.listSessions(IAAA_MEMBERSHIP_KEY_PREFIX);
  if (entries === null) return [];
  return listMembershipsFromEntries(entries);
}

/** resolveTenantLogins over the world's memberships + session registry. */
async function resolveLoginsForTenant(
  stores: ResolvedStores,
  memberships: Membership[],
  tenantId: string,
) {
  const sessionEntries = (await stores.stores.listSessions("")) ?? [];
  return resolveTenantLogins({
    tenantId,
    memberships,
    lookupLogin: (userId: string) => lookupLoginByUserId(stores.kv, userId),
    sessionEntries,
  });
}

/** Tenant-known check for clean state / export: directory OR any membership. */
async function tenantIsKnown(
  stores: ResolvedStores,
  tenantId: string,
): Promise<boolean> {
  if (stores.directory) {
    try {
      const ids = await stores.directory.listTenantIds();
      if (ids.includes(tenantId)) return true;
    } catch {
      // Fall through to the membership evidence.
    }
  }
  const memberships = await allMemberships(stores);
  return memberships.some((m) => m.tenantId === tenantId);
}

async function enumerateClean(
  ctx: DataLifecycleRouteContext,
  stores: ResolvedStores,
  scope: "tenant" | "platform",
  tenantId: string | null,
  callerLogin: string,
): Promise<Enumeration | Response> {
  const defs =
    scope === "platform" ? PLATFORM_CLEAN_TARGETS : TENANT_CLEAN_TARGETS;
  const memberships = await allMemberships(stores);

  let logins: string[] = [];
  let memberIds = new Set<string>();
  if (scope === "tenant" && tenantId !== null) {
    memberIds = new Set(tenantMemberIds(memberships, tenantId));
    const resolved = await resolveLoginsForTenant(stores, memberships, tenantId);
    logins = resolved.resolvedLogins;
  } else {
    const union = new Set<string>();
    for (const tid of listTenantIds(memberships)) {
      const resolved = await resolveLoginsForTenant(stores, memberships, tid);
      for (const login of resolved.resolvedLogins) union.add(login);
    }
    union.add(callerLogin);
    logins = [...union];
  }
  const loginSet = new Set(logins);

  const instancePreview = await runInstanceTargets(
    ctx,
    callerLogin,
    tenantId,
    logins,
    false,
  );

  const kvPlans = new Map<string, KvPlan>();
  const planFor = async (id: string): Promise<KvPlan | null> => {
    switch (id) {
      case "tenant-memberships":
        return membershipPlan(stores, tenantId);
      case "platform-memberships":
        return membershipPlan(stores, null);
      case "tenant-genesis-marker":
        return tenantId === null ? null : markerPlan(stores, tenantId);
      case "platform-genesis-markers":
        return prefixPlan(stores, id, "sessions", [GENESIS_MARKER_PREFIX]);
      case "platform-bindings":
        return prefixPlan(stores, id, "sessions", ["iaaa-binding:", "iaaa-alias:"]);
      case "platform-tokens":
        return prefixPlan(stores, id, "etrade", ["etrade:token:"]);
      case "platform-audit-log":
        return prefixPlan(stores, id, "sessions", [IAAA_AUDIT_KEY_PREFIX]);
      case "tenant-sessions":
        return sessionsPlan(stores, tenantId, memberIds, loginSet);
      case "platform-sessions":
        return sessionsPlan(stores, null, memberIds, loginSet);
      default:
        return null;
    }
  };

  const targets: TargetReport[] = [];
  for (const def of defs) {
    if (def.id === "instance-queues") {
      targets.push({
        id: def.id,
        label: def.label,
        kind: def.kind,
        count: instancePreview.queues.reduce((n, r) => n + r.count, 0),
        perLogin: instancePreview.queues.map((r) => ({
          login: r.login,
          count: r.count,
          ...(r.error ? { error: r.error } : {}),
        })),
      });
      continue;
    }
    if (def.id === "instance-tables") {
      targets.push({
        id: def.id,
        label: def.label,
        kind: def.kind,
        count: instancePreview.tables.reduce((n, r) => n + r.count, 0),
        perLogin: instancePreview.tables.map((r) => ({
          login: r.login,
          count: r.count,
          ...(r.error ? { error: r.error } : {}),
        })),
      });
      continue;
    }
    const plan = await planFor(def.id);
    if (plan === null) {
      // Fail closed (the kvWipe idiom): a namespace that cannot
      // be listed cannot be previewed or cleared honestly.
      return jsonError(
        "Data lifecycle stores are unavailable: a namespace listing failed, so nothing was previewed or cleared.",
        503,
      );
    }
    kvPlans.set(def.id, plan);
    targets.push({ id: def.id, label: def.label, kind: def.kind, count: plan.count });
  }

  return {
    targets,
    kvPlans,
    logins,
    previewToken: await previewTokenFor(scope, tenantId, targets),
  };
}

interface CleanBody {
  scope?: unknown;
  tenantId?: unknown;
  confirm?: unknown;
  confirmText?: unknown;
  auditConfirm?: unknown;
  previewToken?: unknown;
}

function parseCleanScope(
  body: CleanBody,
): { scope: "tenant" | "platform"; tenantId: string | null } | Response {
  if (body.scope !== "tenant" && body.scope !== "platform") {
    return jsonError("A scope of \"tenant\" or \"platform\" is required.", 400);
  }
  if (body.scope === "tenant") {
    if (typeof body.tenantId !== "string" || !isTenantIdShaped(body.tenantId)) {
      return jsonError("A valid tenantId is required for tenant scope.", 400);
    }
    return { scope: "tenant", tenantId: body.tenantId };
  }
  return { scope: "platform", tenantId: null };
}

async function handleCleanState(
  request: Request,
  ctx: DataLifecycleRouteContext,
): Promise<Response> {
  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const stores = resolveStores(ctx);
  const body = (await request.json().catch(() => null)) as CleanBody | null;
  if (!body || typeof body !== "object") {
    return jsonError("A JSON body is required.", 400);
  }
  const parsed = parseCleanScope(body);
  if (parsed instanceof Response) return parsed;
  const { scope, tenantId } = parsed;

  const caller = await resolveWiredCaller(request, stores);
  if (scope === "platform" && !caller.isPlatformAdmin) {
    return jsonError(
      "Forbidden: platform clean state requires a platform-admin membership.",
      403,
    );
  }
  if (scope === "tenant" && tenantId !== null) {
    if (!(await tenantIsKnown(stores, tenantId))) {
      return jsonError(`Unknown tenant: ${tenantId}.`, 404);
    }
  }

  const enumeration = await enumerateClean(ctx, stores, scope, tenantId, operator);
  if (enumeration instanceof Response) return enumeration;

  if (body.confirm !== true) {
    return Response.json({
      scope,
      ...(tenantId !== null ? { tenantId } : {}),
      confirmed: false,
      confirmRequired: true,
      previewToken: enumeration.previewToken,
      targets: enumeration.targets,
    });
  }

  // Confirm gates, in order: the preview binding (409), then the
  // typed confirmations (400). A failed gate deletes nothing.
  if (
    typeof body.previewToken !== "string" ||
    body.previewToken !== enumeration.previewToken
  ) {
    return jsonError(
      "Preview token mismatch: the scope changed since the preview, or no preview was taken. Re-run the preview and confirm against what it shows.",
      409,
    );
  }
  if (scope === "platform" && body.confirmText !== "CLEAN PLATFORM") {
    return jsonError(
      "Platform clean state requires confirmText: \"CLEAN PLATFORM\".",
      400,
    );
  }
  if (body.auditConfirm !== true) {
    return jsonError(
      "Clean state clears the audit-bearing table mas_events in member instances and requires auditConfirm: true.",
      400,
    );
  }

  // Execute: instance fan-out first, then the KV targets in
  // definition order (sessions last by construction of the
  // definitions, so the operator's own session is the final
  // record cleared in platform scope).
  const instanceResult = await runInstanceTargets(
    ctx,
    operator,
    tenantId,
    enumeration.logins,
    true,
  );
  const results: TargetReport[] = [];
  let allOk = true;
  for (const target of enumeration.targets) {
    if (target.id === "instance-queues" || target.id === "instance-tables") {
      const rows =
        target.id === "instance-queues"
          ? instanceResult.queues
          : instanceResult.tables;
      const hasError = rows.some((r) => r.error !== undefined);
      if (hasError) allOk = false;
      results.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        deleted: rows.reduce((n, r) => n + r.count, 0),
        verified: !hasError,
        ...(hasError ? { error: "one or more instances reported an error" } : {}),
        perLogin: rows.map((r) => ({
          login: r.login,
          deleted: r.count,
          ...(r.error ? { error: r.error } : {}),
        })),
      });
      continue;
    }
    const plan = enumeration.kvPlans.get(target.id);
    if (!plan) {
      allOk = false;
      results.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        deleted: 0,
        verified: false,
        error: "target plan missing at execution time",
      });
      continue;
    }
    try {
      const deleted = await plan.execute();
      results.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        deleted,
        verified: true,
      });
    } catch (err) {
      allOk = false;
      results.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        deleted: 0,
        verified: false,
        error: err instanceof Error ? err.message : "clear failed",
      });
    }
  }

  const audit = await auditOperation(ctx, stores, {
    action: "data-lifecycle.clean-state",
    tenantId: tenantId ?? stores.iaaaTenantId,
    actorLogin: operator,
    actorInternalUserId: caller.internalUserId,
    succeeded: allOk,
    funnelPayload: {
      scope,
      ...(tenantId !== null ? { tenantId } : {}),
      targets: results.map((r) => ({
        id: r.id,
        deleted: r.deleted ?? 0,
        ...(r.error ? { error: r.error } : {}),
      })),
    },
  });

  return Response.json({
    scope,
    ...(tenantId !== null ? { tenantId } : {}),
    confirmed: true,
    targets: results,
    audit,
  });
}

async function handleExport(
  request: Request,
  url: URL,
  ctx: DataLifecycleRouteContext,
): Promise<Response> {
  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const stores = resolveStores(ctx);
  const scopeParam = url.searchParams.get("scope");
  if (scopeParam !== "tenant" && scopeParam !== "platform") {
    return jsonError("A scope of \"tenant\" or \"platform\" is required.", 400);
  }
  const scope = scopeParam;
  let tenantId: string | null = null;
  if (scope === "tenant") {
    const raw = url.searchParams.get("tenantId") ?? "";
    if (!isTenantIdShaped(raw)) {
      return jsonError("A valid tenantId is required for tenant scope.", 400);
    }
    tenantId = raw;
    if (!(await tenantIsKnown(stores, raw))) {
      return jsonError(`Unknown tenant: ${raw}.`, 404);
    }
  } else {
    const caller = await resolveWiredCaller(request, stores);
    if (!caller.isPlatformAdmin) {
      return jsonError(
        "Forbidden: the platform export bundle includes the audit log and requires a platform-admin membership.",
        403,
      );
    }
  }

  const enumeration = await enumerateClean(ctx, stores, scope, tenantId, operator);
  if (enumeration instanceof Response) return enumeration;

  if (scope === "platform") {
    // The bundle carries the audit log in its STORED form: the
    // hash-chained segments under the audit prefix. Both audit
    // compositions (legacy atomic store and the step-5d port)
    // persist to these same segments in the SessionStore
    // (createWiredAuditStore), so the segments are exactly what
    // a platform clean state is about to delete — the honest
    // pre-wipe capture. Unparseable segments are counted, never
    // silently dropped.
    const segmentEntries =
      (await stores.stores.listSessions(IAAA_AUDIT_KEY_PREFIX)) ?? [];
    const events: unknown[] = [];
    let corruptSegments = 0;
    for (const entry of [...segmentEntries].sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      try {
        const parsed = JSON.parse(entry.value) as unknown;
        if (Array.isArray(parsed)) {
          events.push(...parsed);
        } else {
          corruptSegments += 1;
        }
      } catch {
        corruptSegments += 1;
      }
    }
    return Response.json({
      scope,
      exportedAtMs: stores.nowMs(),
      targets: enumeration.targets,
      auditLog: {
        count: events.length,
        truncated: events.length > AUDIT_EXPORT_CAP,
        corruptSegments,
        events: events.slice(0, AUDIT_EXPORT_CAP),
      },
    });
  }
  // Tenant bundles carry the enumeration only: the audit chain is
  // platform-global and is never decomposed per tenant.
  return Response.json({
    scope,
    tenantId,
    exportedAtMs: stores.nowMs(),
    targets: enumeration.targets,
  });
}

// ---------------------------------------------------------------------------
// Genesis (shared by platform initialize and the tenant claim)
// ---------------------------------------------------------------------------

/**
 * Perform a genesis claim EXACTLY as the login path does
 * (iaaaGithubEndToEnd): atomic marker claim first when the KV
 * supports putIfAbsent, then the platform-admin grant; a failed
 * grant releases the claim. Without putIfAbsent, the legacy
 * create-then-put order is preserved.
 */
async function performGenesis(
  stores: ResolvedStores,
  tenantId: string,
  internalUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const markerKey = platformGenesisMarkerKey(tenantId);
  const markerValue = JSON.stringify({
    grantedTo: internalUserId,
    tenantId,
    atMs: stores.nowMs(),
  });
  const grant = async (): Promise<boolean> => {
    try {
      const created = await createMembership(stores.membershipStore, {
        internalUserId,
        tenantId,
        roleBindings: [
          {
            role: "platform-admin",
            scope: "platform",
            grantedBy: "system:bootstrap-genesis",
          },
        ],
        createdBy: "system:bootstrap-genesis",
        nowMs: stores.nowMs(),
      });
      return created.ok;
    } catch {
      return false;
    }
  };
  if (typeof stores.kv.putIfAbsent === "function") {
    let claimed = false;
    try {
      claimed = await stores.kv.putIfAbsent(markerKey, markerValue);
    } catch {
      claimed = false;
    }
    if (!claimed) {
      return { ok: false, error: "genesis marker was claimed concurrently" };
    }
    if (!(await grant())) {
      await stores.kv.delete(markerKey).catch(() => undefined);
      return { ok: false, error: "genesis grant failed; the marker claim was released" };
    }
    return { ok: true };
  }
  if (!(await grant())) {
    return { ok: false, error: "genesis grant failed" };
  }
  await stores.kv.put(markerKey, markerValue);
  return { ok: true };
}

/** Is this wired identity named by a `platform:` bootstrap entry? */
async function callerIsGenesisEntry(
  env: Env,
  stores: ResolvedStores,
  internalUserId: string,
): Promise<boolean> {
  const parsed = parseBootstrapListWithGenesis(
    (env as unknown as Record<string, unknown>)["IAAA_BOOTSTRAP_ADMINS"] as
      | string
      | undefined,
  );
  const bindingStore = createKvBindingStore(stores.kv);
  for (const item of parsed.entries) {
    if (!item.genesis) continue;
    const entry = item.entry;
    const resolved =
      entry.kind === "internalUserId"
        ? entry.internalUserId
        : await getInternalUserId(
            bindingStore,
            entry.providerIssuer,
            entry.providerSubject,
          );
    if (resolved === internalUserId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Platform bootstrap
// ---------------------------------------------------------------------------

type BootstrapElementState =
  | "present"
  | "initialized"
  | "missing"
  | "external"
  | "failed";

interface BootstrapElementReport {
  id: string;
  state: BootstrapElementState;
  detail: string;
  source: string;
}

async function checkPlatformBootstrap(
  ctx: DataLifecycleRouteContext,
  stores: ResolvedStores,
): Promise<BootstrapElementReport[]> {
  const elements: BootstrapElementReport[] = [];

  // 1. SessionStore schema — ensured by the DO constructor; the
  // in-route probe is the listing call itself.
  const probe = await stores.stores.listSessions("");
  elements.push({
    id: "session-store-schema",
    state: probe !== null ? "present" : "missing",
    detail:
      probe !== null
        ? `SessionStore answers listings; schema generation ${SESSION_STORE_SCHEMA_VERSION} is ensured by the SessionStore DO constructor.`
        : "SessionStore does not answer listings; the schema is ensured by the DO constructor when the store is reachable, so there is no in-route repair.",
    source:
      "src/security/sessionStore.ts (SESSION_STORE_SCHEMA_VERSION); src/data/doSessionStoreAdapter.ts (ensureSchema)",
  });

  // 2. AgentDB (D1) schema — migrations are deployment-time.
  if (!stores.directory) {
    elements.push({
      id: "agent-db-schema",
      state: "external",
      detail:
        "AGENT_DB is not bound, so the tenant directory cannot answer; the D1 schema comes from deployment-time migrations.",
      source: "migrations/0007, 0026, 0028; src/data/tenantDirectoryPorts.ts",
    });
  } else {
    try {
      const ids = await stores.directory.listTenantIds();
      elements.push({
        id: "agent-db-schema",
        state: "present",
        detail: `Tenant directory answers (${ids.length} tenant record(s)); the schema comes from D1 migrations 0007/0026/0028, applied at deployment.`,
        source: "migrations/0007, 0026, 0028; src/data/tenantDirectoryPorts.ts",
      });
    } catch (err) {
      elements.push({
        id: "agent-db-schema",
        state: "external",
        detail: `Tenant directory does not answer (${err instanceof Error ? err.message : "error"}); D1 migrations are applied at deployment (wrangler), not from a route.`,
        source: "migrations/0007, 0026, 0028; src/data/tenantDirectoryPorts.ts",
      });
    }
  }

  // 3. Reference data — code-level defaults; the survey for this
  // slice found no stored seed writers anywhere in the codebase.
  elements.push({
    id: "reference-data",
    state: "present",
    detail:
      "Reference data is in-code by construction: DEFAULT_TENANT_CHANNELS, the commercial store's absent-row defaults, and the data-provider registry. No stored seed rows exist to initialize.",
    source:
      "src/data/tenantChannelPorts.ts; src/data/commercialPorts.ts; src/data (provider registry)",
  });

  // 4. Platform genesis for the IAAA tenant.
  const markerKey = platformGenesisMarkerKey(stores.iaaaTenantId);
  const marker = await stores.kv.get(markerKey);
  if (marker !== null) {
    let grantedTo = "unknown";
    try {
      const parsed = JSON.parse(marker) as { grantedTo?: unknown };
      if (typeof parsed.grantedTo === "string") grantedTo = parsed.grantedTo;
    } catch {
      // A present-but-unparseable marker still closes the window.
    }
    elements.push({
      id: "platform-genesis",
      state: "present",
      detail: `Genesis marker present for tenant "${stores.iaaaTenantId}" (grantedTo: ${grantedTo}); the genesis window is closed.`,
      source: "src/security/iaaaGithubEndToEnd.ts (platformGenesisMarkerKey)",
    });
  } else {
    elements.push({
      id: "platform-genesis",
      state: "missing",
      detail: `No genesis marker for tenant "${stores.iaaaTenantId}"; the genesis window is open for a platform: bootstrap entry.`,
      source: "src/security/iaaaGithubEndToEnd.ts (platformGenesisMarkerKey)",
    });
  }

  // 5. Bootstrap admins configuration. The env var's full
  // grammar is parseBootstrapListWithGenesis (the login path's
  // parser, which wraps parseBootstrapAdmins and adds the
  // platform: genesis prefix).
  const admins = parseBootstrapListWithGenesis(
    (ctx.env as unknown as Record<string, unknown>)[
      "IAAA_BOOTSTRAP_ADMINS"
    ] as string | undefined,
  );
  if (admins.rejected.length > 0) {
    elements.push({
      id: "bootstrap-admins",
      state: "external",
      detail: `IAAA_BOOTSTRAP_ADMINS has rejected entries (${admins.rejected.map((r) => r.reason).join("; ")}); bootstrap admins are deployment configuration — fix the configuration, there is no in-route action.`,
      source: "src/security/iaaaGithubEndToEnd.ts (parseBootstrapListWithGenesis); src/security/iaaaBootstrap.ts (parseBootstrapAdmins)",
    });
  } else if (admins.entries.length > 0) {
    elements.push({
      id: "bootstrap-admins",
      state: "present",
      detail: `${admins.entries.length} bootstrap admin entr${admins.entries.length === 1 ? "y" : "ies"} configured in IAAA_BOOTSTRAP_ADMINS.`,
      source: "src/security/iaaaBootstrap.ts (parseBootstrapAdmins)",
    });
  } else {
    elements.push({
      id: "bootstrap-admins",
      state: "external",
      detail:
        "IAAA_BOOTSTRAP_ADMINS is not configured; bootstrap admins are deployment configuration (env), with changes governed by the #3077 proposal flow — there is no in-route action.",
      source: "src/security/iaaaBootstrap.ts (parseBootstrapAdmins)",
    });
  }

  return elements;
}

async function handlePlatformBootstrapCheck(
  request: Request,
  ctx: DataLifecycleRouteContext,
): Promise<Response> {
  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const stores = resolveStores(ctx);
  const elements = await checkPlatformBootstrap(ctx, stores);
  return Response.json({
    tenantId: stores.iaaaTenantId,
    elements,
    allPresent: elements.every((e) => e.state === "present"),
  });
}

async function handlePlatformBootstrapInit(
  request: Request,
  ctx: DataLifecycleRouteContext,
): Promise<Response> {
  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const stores = resolveStores(ctx);
  const body = (await request.json().catch(() => null)) as {
    confirm?: unknown;
  } | null;
  const elements = await checkPlatformBootstrap(ctx, stores);
  if (!body || body.confirm !== true) {
    // A check, not an action: nothing performed, nothing audited.
    return Response.json({
      tenantId: stores.iaaaTenantId,
      confirmed: false,
      confirmRequired: true,
      elements,
    });
  }

  const caller = await resolveWiredCaller(request, stores);
  for (const element of elements) {
    if (element.id !== "platform-genesis" || element.state !== "missing") {
      continue;
    }
    if (
      caller.internalUserId !== null &&
      (await callerIsGenesisEntry(ctx.env, stores, caller.internalUserId))
    ) {
      const result = await performGenesis(
        stores,
        stores.iaaaTenantId,
        caller.internalUserId,
      );
      if (result.ok) {
        element.state = "initialized";
        element.detail = `Genesis claimed for ${caller.internalUserId} exactly as the login path performs it (atomic marker claim + platform-admin grant).`;
      } else {
        element.state = "failed";
        element.detail = `Genesis claim failed: ${result.error}.`;
      }
    } else {
      element.state = "external";
      element.detail =
        "The caller is not a platform: entry in IAAA_BOOTSTRAP_ADMINS; genesis is claimed by a configured bootstrap admin here or at that admin's first login — it cannot be forced by another operator.";
    }
  }

  const succeeded = elements.every(
    (e) => e.state === "present" || e.state === "initialized",
  );
  const audit = await auditOperation(ctx, stores, {
    action: "data-lifecycle.platform-bootstrap",
    tenantId: stores.iaaaTenantId,
    actorLogin: operator,
    actorInternalUserId: caller.internalUserId,
    succeeded,
    funnelPayload: {
      elements: elements.map((e) => ({ id: e.id, state: e.state })),
    },
  });
  return Response.json({
    tenantId: stores.iaaaTenantId,
    confirmed: true,
    elements,
    audit,
  });
}

// ---------------------------------------------------------------------------
// Tenant bootstrap
// ---------------------------------------------------------------------------

type TenantStepStatus =
  | "present"
  | "initialized"
  | "would-initialize"
  | "missing"
  | "not-requested"
  | "skipped"
  | "failed";

interface TenantStepReport {
  id: string;
  status: TenantStepStatus;
  detail: string;
}

interface TenantSettingsView {
  adsEnabled: boolean;
  autoRefreshEnabled: boolean;
  dataProviderId: string;
  brokerId: string;
}

async function readSettingsView(
  commercial: CommercialStore,
  tenantId: string,
): Promise<TenantSettingsView> {
  const [adsEnabled, autoRefresh, providers] = await Promise.all([
    commercial.getTenantAdsEnabled(tenantId),
    commercial.getTenantAutoRefresh(tenantId),
    commercial.getTenantProviders(tenantId),
  ]);
  return {
    adsEnabled,
    autoRefreshEnabled: autoRefresh.enabled,
    dataProviderId: providers.dataProviderId,
    brokerId: providers.brokerId,
  };
}

function describeSettings(view: TenantSettingsView): string {
  return `adsEnabled=${view.adsEnabled}, autoRefreshEnabled=${view.autoRefreshEnabled}, dataProviderId=${view.dataProviderId}, brokerId=${view.brokerId} (absent-row defaults until an operator patches them)`;
}

interface TenantBootstrapBody {
  tenantId?: unknown;
  foundingAdminLogin?: unknown;
  claimGenesis?: unknown;
  confirm?: unknown;
}

async function handleTenantBootstrap(
  request: Request,
  ctx: DataLifecycleRouteContext,
): Promise<Response> {
  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const stores = resolveStores(ctx);
  const body = (await request.json().catch(() => null)) as
    | TenantBootstrapBody
    | null;
  if (!body || typeof body !== "object") {
    return jsonError("A JSON body is required.", 400);
  }
  if (typeof body.tenantId !== "string" || !isTenantIdShaped(body.tenantId)) {
    return jsonError("A valid tenantId is required.", 400);
  }
  const tenantId = body.tenantId;
  let foundingAdminLogin: string | null = null;
  if (body.foundingAdminLogin !== undefined && body.foundingAdminLogin !== null) {
    if (
      typeof body.foundingAdminLogin !== "string" ||
      !isLoginShaped(body.foundingAdminLogin.trim())
    ) {
      return jsonError("foundingAdminLogin is not a valid login.", 400);
    }
    foundingAdminLogin = body.foundingAdminLogin.trim();
  }
  const claimGenesis = body.claimGenesis === true;
  const confirm = body.confirm === true;
  if (!stores.directory || !stores.commercial) {
    return jsonError(
      "Tenant stores are not bound (AGENT_DB); tenant bootstrap is unavailable.",
      503,
    );
  }
  const directory = stores.directory;
  const commercial = stores.commercial;
  const nowMs = stores.nowMs();

  const steps: TenantStepReport[] = [];
  let settingsView: TenantSettingsView | null = null;

  // -- directory -------------------------------------------------------------
  let inDirectory = false;
  let directoryFailed = false;
  let createdThisRun = false;
  try {
    inDirectory = (await directory.listTenantIds()).includes(tenantId);
  } catch (err) {
    directoryFailed = true;
    steps.push({
      id: "directory",
      status: "failed",
      detail: `Tenant directory does not answer: ${err instanceof Error ? err.message : "error"}.`,
    });
  }
  if (!directoryFailed) {
    if (inDirectory) {
      steps.push({
        id: "directory",
        status: "present",
        detail: "The tenant has a directory record.",
      });
    } else if (!confirm) {
      steps.push({
        id: "directory",
        status: "would-initialize",
        detail:
          "No directory record; confirming creates the tenant record with store defaults (the tenant-admin create path).",
      });
    } else {
      try {
        await commercial.setTenantAdsEnabled(tenantId, true);
        createdThisRun = true;
        steps.push({
          id: "directory",
          status: "initialized",
          detail:
            "Tenant record created with store defaults (the tenant-admin create path).",
        });
      } catch (err) {
        directoryFailed = true;
        steps.push({
          id: "directory",
          status: "failed",
          detail: `Creating the tenant record failed: ${err instanceof Error ? err.message : "error"}.`,
        });
      }
    }
  }

  // -- settings ---------------------------------------------------------------
  if (directoryFailed) {
    steps.push({
      id: "settings",
      status: "skipped",
      detail: "Skipped because the directory step failed.",
    });
  } else if (!inDirectory && !confirm) {
    steps.push({
      id: "settings",
      status: "would-initialize",
      detail:
        "Effective settings will read as the store defaults once the record exists.",
    });
  } else {
    try {
      settingsView = await readSettingsView(commercial, tenantId);
      steps.push({
        id: "settings",
        status: createdThisRun ? "initialized" : "present",
        detail: `Effective settings verified through the settings port: ${describeSettings(settingsView)}.`,
      });
    } catch (err) {
      steps.push({
        id: "settings",
        status: "failed",
        detail: `Reading effective settings failed: ${err instanceof Error ? err.message : "error"}.`,
      });
    }
  }

  // -- founding admin -----------------------------------------------------------
  let founderId: string | null = null;
  if (foundingAdminLogin === null) {
    steps.push({
      id: "founding-admin",
      status: "not-requested",
      detail: "No founding admin login was supplied.",
    });
  } else {
    founderId = await lookupInternalUserIdByLogin(stores.kv, foundingAdminLogin);
    if (founderId === null) {
      steps.push({
        id: "founding-admin",
        status: "missing",
        detail: `No identity binding exists for login "${foundingAdminLogin}"; identity is never invented — the user must sign in once (or be migrated) before they can be provisioned.`,
      });
    } else {
      const existing = await stores.membershipStore.getMembershipsByUser(founderId);
      const alreadyAdmin = existing.some(
        (m) =>
          m.tenantId === tenantId &&
          m.revokedAtMs === undefined &&
          m.roleBindings.some(
            (b) =>
              b.role === "tenant-admin" &&
              b.scope === "tenant" &&
              (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
          ),
      );
      if (alreadyAdmin) {
        steps.push({
          id: "founding-admin",
          status: "present",
          detail: `"${foundingAdminLogin}" already holds tenant-admin for this tenant.`,
        });
      } else if (!confirm) {
        steps.push({
          id: "founding-admin",
          status: "would-initialize",
          detail: `"${foundingAdminLogin}" resolves to a wired identity; confirming grants tenant-admin (system:bootstrap).`,
        });
      } else {
        const result = await provisionBootstrapAdmins(stores.membershipStore, {
          tenantId,
          internalUserIds: [founderId],
          nowMs,
        });
        if (!result.ok) {
          steps.push({
            id: "founding-admin",
            status: "failed",
            detail: `Provisioning failed: ${result.error}.`,
          });
        } else if (result.provisioned.includes(founderId)) {
          steps.push({
            id: "founding-admin",
            status: "initialized",
            detail: `"${foundingAdminLogin}" granted tenant-admin (system:bootstrap).`,
          });
        } else {
          steps.push({
            id: "founding-admin",
            status: "present",
            detail: `"${foundingAdminLogin}" already holds tenant-admin for this tenant.`,
          });
        }
      }
    }
  }

  // -- genesis ------------------------------------------------------------------
  const markerKey = platformGenesisMarkerKey(tenantId);
  const marker = await stores.kv.get(markerKey);
  if (marker !== null) {
    let grantedTo = "unknown";
    try {
      const parsed = JSON.parse(marker) as { grantedTo?: unknown };
      if (typeof parsed.grantedTo === "string") grantedTo = parsed.grantedTo;
    } catch {
      // Present-but-unparseable still closes the window.
    }
    steps.push({
      id: "genesis",
      status: "present",
      detail: `Genesis marker present (grantedTo: ${grantedTo}); the window is closed.`,
    });
  } else if (!claimGenesis) {
    steps.push({
      id: "genesis",
      status: "not-requested",
      detail:
        "Genesis claim not requested; the marker window stays open for the founding admin's first platform-scoped login, or re-run with claimGenesis: true.",
    });
  } else if (founderId === null) {
    steps.push({
      id: "genesis",
      status: "skipped",
      detail:
        "Skipped: a genesis claim needs a resolved founding admin as its grantee.",
    });
  } else {
    const caller = await resolveWiredCaller(request, stores);
    if (!caller.isPlatformAdmin) {
      steps.push({
        id: "genesis",
        status: "missing",
        detail:
          "Claiming genesis mints a platform-admin membership and requires the caller to hold a platform-admin membership; the marker was not written.",
      });
    } else if (!confirm) {
      steps.push({
        id: "genesis",
        status: "would-initialize",
        detail:
          "Confirming claims genesis for the founding admin (atomic marker claim + platform-admin grant).",
      });
    } else {
      const result = await performGenesis(stores, tenantId, founderId);
      steps.push(
        result.ok
          ? {
              id: "genesis",
              status: "initialized",
              detail:
                "Genesis claimed for the founding admin (atomic marker claim + platform-admin grant).",
            }
          : {
              id: "genesis",
              status: "failed",
              detail: `Genesis claim failed: ${result.error}.`,
            },
      );
    }
  }

  // -- channels -------------------------------------------------------------------
  if (!stores.channels) {
    steps.push({
      id: "channels",
      status: "failed",
      detail: "The tenant channel store is not bound (AGENT_DB).",
    });
  } else {
    try {
      if (confirm) {
        // Materialize the defaults row so the tenant's channel
        // configuration is stored state, not only absent-row
        // semantics; the patch is empty, so operator choices are
        // never overwritten by a re-run.
        await stores.channels.setTenantChannels(tenantId, {});
      }
      const config: TenantChannelConfig =
        await stores.channels.getTenantChannels(tenantId);
      const flags = Object.entries(config)
        .map(([name, on]) => `${name}=${on ? "on" : "off"}`)
        .join(", ");
      steps.push({
        id: "channels",
        status: "present",
        detail: `Channel configuration in effect (${flags}); defaults apply until an operator patches them.`,
      });
    } catch (err) {
      steps.push({
        id: "channels",
        status: "failed",
        detail: `Channel provisioning failed: ${err instanceof Error ? err.message : "error"}.`,
      });
    }
  }

  // -- queue provisioning ---------------------------------------------------------
  {
    const memberships = await allMemberships(stores);
    const resolved = await resolveLoginsForTenant(stores, memberships, tenantId);
    steps.push({
      id: "queue-provisioning",
      status: "present",
      detail: `${resolved.resolvedLogins.length} member login(s) resolve to per-login instances (${resolved.unmappedMembers.length} member(s) unmapped); instances and their queues are provisioned lazily by the framework — this step writes nothing.`,
    });
  }

  const partial = steps.some(
    (s) =>
      s.status === "missing" || s.status === "failed" || s.status === "skipped",
  );
  const outcome = partial ? "partial" : "complete";

  let audit: { funnel: true; auditLog: { ok: boolean; error?: string } } | undefined;
  if (confirm) {
    const caller = await resolveWiredCaller(request, stores);
    audit = await auditOperation(ctx, stores, {
      action: "data-lifecycle.tenant-bootstrap",
      tenantId,
      actorLogin: operator,
      actorInternalUserId: caller.internalUserId,
      succeeded: !partial,
      funnelPayload: {
        tenantId,
        outcome,
        foundingAdminLogin,
        claimGenesis,
        steps: steps.map((s) => ({ id: s.id, status: s.status })),
      },
    });
  }

  return Response.json({
    tenantId,
    confirmed: confirm,
    ...(confirm ? { outcome } : {}),
    steps,
    ...(settingsView ? { settings: settingsView } : {}),
    ...(audit ? { audit } : {}),
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleDataLifecycleRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string | null,
  ctx: DataLifecycleRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  // endsWith matching on the dispatch path, the kvWipe idiom:
  // tolerant of the /api prefix, which src/server.ts strips
  // before the DO dispatch (the path is url.pathname — it never
  // carries a query string).
  if (path.endsWith("/data-lifecycle/clean-state") && request.method === "POST") {
    return handleCleanState(request, ctx);
  }
  if (path.endsWith("/data-lifecycle/export") && request.method === "GET") {
    return handleExport(request, url, ctx);
  }
  if (path.endsWith("/data-lifecycle/bootstrap") && request.method === "GET") {
    return handlePlatformBootstrapCheck(request, ctx);
  }
  if (path.endsWith("/data-lifecycle/bootstrap") && request.method === "POST") {
    return handlePlatformBootstrapInit(request, ctx);
  }
  if (path.endsWith("/data-lifecycle/tenant-bootstrap") && request.method === "POST") {
    return handleTenantBootstrap(request, ctx);
  }
  return null;
}
