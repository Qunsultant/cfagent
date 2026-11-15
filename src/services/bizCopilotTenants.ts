/**
 * Issue #4515 (BizCopilot slice 1, umbrella #4514) — tenant
 * administration through the BizCopilot chat tab, modeled on the
 * Stock Copilot pattern but deterministic: the turn's BizCopilot
 * branch parses the user's text for the four tenant activities
 * (create / list / detail+members / settings read+update) and
 * executes them by calling the SAME server paths the Tenants page
 * uses — handlePlatformTenantRoutes in-process, with the same
 * store-operator gate, session-scoped identity, and audit as the
 * page path. No second implementation, no new server capability.
 *
 * The branch runs in OrchestratorAgent.portBeforeTurn (the
 * auto-options-research branch's shape): the deterministic result
 * is injected into the system prompt as retrieved content and the
 * model only narrates it (activeTools: []), exactly as the
 * auto-research job context is narrated.
 *
 * BOUNDED WAIT (#4513): the chat create path never fetches. The
 * executor calls the route handler in-process against the D1
 * ports — a fixed small number of store calls, the same calls the
 * page path makes (list/create/detail/settings), no polling, no
 * retries, no unbounded loop. A failure anywhere surfaces as an
 * explicit BIZCOPILOT_TENANT_ERROR outcome, never a silent spin.
 * The page path's own 30s fetch bound (#4528) stays the page's
 * bound; this path needs none because it never leaves the process.
 *
 * CONSERVATIVE PARSING: only explicit commands parse. Anything
 * ambiguous, partial, or unrecognized returns null and the turn
 * proceeds as a normal LLM turn — the model may ask for
 * clarification, but no mutation is ever guessed. Membership
 * WRITES parse to an explicit refusal (the membership view is
 * read-only here, exactly as on the page; IAAA writes are
 * CISO-lane) — the refusal is deterministic context, never a
 * route call.
 *
 * RSI posture (slice 1): BizCopilot turns already flow through the
 * generic evaluation path (judge.evaluate + VectorMemory in
 * portOnChatResponse) and the turn audit records every executed
 * action (bizcopilot.tenant_action_executed/failed). Behavior
 * changes only through governed adoption (code change + CI), never
 * silently — the governed RSI loop's observation step is the audit
 * trail, and adoption is a PR.
 */

import { handlePlatformTenantRoutes, isTenantIdShaped } from "../agents/routes/platformTenants";
import type { CommercialStore } from "../data/commercialPorts";
import type { TenantDirectory } from "../data/tenantDirectoryPorts";
import type { StoreOperators } from "../data/storeOperatorsPorts";
import { copilotRegistrationForSourceTab } from "./copilotChannels";

/** The Tenants page every BizCopilot tenant result links, so the user can open and verify what was done. */
export const BIZCOPILOT_TENANTS_PAGE_URL =
  "https://agent.openaimp.com/?tab=platform-admin&view=tenants";

/** The registration id the BizCopilot tab carries (pins against the client registry + copilotChannels). */
export const BIZCOPILOT_REGISTRATION_ID = "biz" as const;

/** Flat partial settings patch: only the fields the user named. The executor merges the rest from the stored settings. */
export interface BizCopilotTenantSettingsPatch {
  adsEnabled?: boolean;
  autoRefreshEnabled?: boolean;
  autoRefreshIntervalS?: number;
  dataProviderId?: string;
  brokerId?: string;
}

export type BizCopilotTenantIntent =
  | { action: "list" }
  | { action: "create"; tenantId: string }
  | { action: "detail"; tenantId: string }
  | { action: "settings-read"; tenantId: string }
  | { action: "settings-update"; tenantId: string; patch: BizCopilotTenantSettingsPatch }
  | { action: "membership-write-refused"; tenantId: string; userId: string };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
}

function isInterval(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse one tenant command. Returns null for anything that is not
 * an explicit tenant command — the turn then proceeds normally.
 */
export function parseBizCopilotTenantIntent(text: string): BizCopilotTenantIntent | null {
  const raw = normalize(text);
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Membership writes are a deterministic refusal, never a route call.
  const membership = /^(?:add|invite|remove)(?: a)? (?:member|user) (\S+) (?:to|from) (?:tenant )?(\S+)$/i.exec(raw);
  if (membership) {
    const userId = membership[1];
    const tenantId = membership[2];
    if (userId && isTenantIdShaped(tenantId)) {
      return { action: "membership-write-refused", tenantId, userId };
    }
    return null;
  }

  if (/^(?:list|show|display)(?: me)? (?:all )?(?:the )?tenants?$/.test(lower)) {
    return { action: "list" };
  }

  const create = /^(?:create|add)(?: a)? tenant (?:named |called )?(\S+)$/i.exec(raw);
  if (create) {
    const tenantId = create[1];
    if (isTenantIdShaped(tenantId)) return { action: "create", tenantId };
    return null;
  }

  const members = /^(?:show|display|list)(?: me)? (?:the )?members(?: of)? (?:tenant )?(\S+)$/i.exec(raw);
  if (members) {
    const tenantId = members[1];
    if (isTenantIdShaped(tenantId)) return { action: "detail", tenantId };
    return null;
  }

  const settingsRead =
    /^(?:(?:show|display|get)(?: me)? (?:the )?settings|what are (?:the )?settings)(?: for| of)? (?:tenant )?(\S+)$/i.exec(raw);
  if (settingsRead) {
    const tenantId = settingsRead[1];
    if (isTenantIdShaped(tenantId)) return { action: "settings-read", tenantId };
    return null;
  }

  const adsOff = /^(?:(?:turn|switch|set) ads (on|off)|(?:enable|disable) ads)(?: for)? (?:tenant )?(\S+)$/.exec(lower);
  if (adsOff) {
    const tenantId = adsOff[2];
    if (!isTenantIdShaped(tenantId)) return null;
    const enabled = adsOff[1] === "on" || lower.startsWith("enable");
    return { action: "settings-update", tenantId, patch: { adsEnabled: enabled } };
  }

  const refreshToggle =
    /^(?:(?:turn|switch|set) auto-?refresh (on|off)|(?:enable|disable) auto-?refresh)(?: for)? (?:tenant )?(\S+)$/.exec(lower);
  if (refreshToggle) {
    const tenantId = refreshToggle[2];
    if (!isTenantIdShaped(tenantId)) return null;
    const enabled = refreshToggle[1] === "on" || lower.startsWith("enable");
    return { action: "settings-update", tenantId, patch: { autoRefreshEnabled: enabled } };
  }

  const refreshInterval =
    /^set auto-?refresh interval (?:to )?(\d+) ?(?:seconds?|s)?(?: for)? (?:tenant )?(\S+)$/.exec(lower);
  if (refreshInterval) {
    const intervalS = isInterval(refreshInterval[1]);
    const tenantId = refreshInterval[2];
    if (intervalS === null || !isTenantIdShaped(tenantId)) return null;
    return { action: "settings-update", tenantId, patch: { autoRefreshIntervalS: intervalS } };
  }

  const providersBoth =
    /^set data provider to (\S+) and broker to (\S+)(?: for)? (?:tenant )?(\S+)$/i.exec(raw);
  if (providersBoth) {
    const tenantId = providersBoth[3];
    if (!isTenantIdShaped(tenantId)) return null;
    return {
      action: "settings-update",
      tenantId,
      patch: { dataProviderId: providersBoth[1], brokerId: providersBoth[2] },
    };
  }

  const providerOne = /^set (?:data )?provider to (\S+)(?: for)? (?:tenant )?(\S+)$/i.exec(raw);
  if (providerOne) {
    const tenantId = providerOne[2];
    if (!isTenantIdShaped(tenantId)) return null;
    return { action: "settings-update", tenantId, patch: { dataProviderId: providerOne[1] } };
  }

  const brokerOne = /^set broker to (\S+)(?: for)? (?:tenant )?(\S+)$/i.exec(raw);
  if (brokerOne) {
    const tenantId = brokerOne[2];
    if (!isTenantIdShaped(tenantId)) return null;
    return { action: "settings-update", tenantId, patch: { brokerId: brokerOne[1] } };
  }

  const detail = /^(?:show|display|get)(?: me)? (?:the )?tenant (\S+)(?: (?:details|members|info))?$/i.exec(raw);
  if (detail) {
    const tenantId = detail[1];
    if (isTenantIdShaped(tenantId)) return { action: "detail", tenantId };
    return null;
  }

  return null;
}

interface BizCopilotTenantExecutorDeps {
  /** Worker env (carries the AGENT_DB binding) — the same env the HTTP dispatch passes. */
  env: { AGENT_DB?: unknown };
  /** The turn's verified login (from the session, never client-supplied) — the operator identity the route gates on. */
  userLogin: string;
  /** Test seams: the route handler composes the adapters from env when these are absent, exactly as the HTTP dispatch does. */
  commercial?: CommercialStore | null;
  directory?: TenantDirectory | null;
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

type TenantRouteResult = { ok: boolean; status: number; body: Record<string, unknown> };

async function callTenantRoute(
  method: string,
  suffix: string,
  body: Record<string, unknown> | undefined,
  deps: BizCopilotTenantExecutorDeps,
): Promise<TenantRouteResult> {
  const url = new URL(`https://bizcopilot.internal/api/platform-tenants${suffix}`);
  const request = new Request(url.toString(), {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-login": deps.userLogin,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handlePlatformTenantRoutes(request, url, url.pathname, "bizcopilot-chat", {
    env: deps.env,
    commercial: deps.commercial,
    directory: deps.directory,
    operators: deps.operators,
  });
  if (!response) {
    return { ok: false, status: 500, body: { error: "Tenant administration did not match a route." } };
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, body: parsed ?? {} };
}

function resultContext(intent: BizCopilotTenantIntent, result: TenantRouteResult): string {
  const payload = {
    action: intent.action,
    tenantId: "tenantId" in intent ? intent.tenantId : null,
    pageUrl: BIZCOPILOT_TENANTS_PAGE_URL,
    ...(result.ok ? { result: result.body } : { status: result.status, error: result.body }),
  };
  return result.ok
    ? `BIZCOPILOT_TENANT_RESULT: ${JSON.stringify(payload)}`
    : `BIZCOPILOT_TENANT_ERROR: ${JSON.stringify(payload)}`;
}

/**
 * The BizCopilot turn branch (called from
 * OrchestratorAgent.portBeforeTurn): on a BizCopilot turn whose
 * text parses as an explicit tenant command, execute it
 * deterministically through the Tenants page's own routes and
 * return the outcome context for the system prompt. Returns ""
 * when the turn is not a BizCopilot tenant command — the turn
 * then proceeds normally. Route-level failures are outcomes in
 * the returned context, never thrown; only an unexpected
 * transport failure inside the handler throws, and the caller
 * turns it into an ERROR context.
 */
export async function runBizCopilotTenantBranch(deps: {
  sourceTab?: string;
  userText: string;
  env: { AGENT_DB?: unknown };
  userLogin: string;
  audit: (type: string, payload: Record<string, unknown>) => void;
  /** Test seams: the route handler composes the adapters from env when these are absent, exactly as the HTTP dispatch does. */
  commercial?: CommercialStore | null;
  directory?: TenantDirectory | null;
  operators?: Pick<StoreOperators, "listOperators"> | null;
}): Promise<string> {
  if (copilotRegistrationForSourceTab(deps.sourceTab) !== BIZCOPILOT_REGISTRATION_ID) return "";
  const intent = parseBizCopilotTenantIntent(deps.userText);
  if (!intent) return "";
  try {
    const context = await executeBizCopilotTenantIntent(intent, {
      env: deps.env,
      userLogin: deps.userLogin,
      commercial: deps.commercial,
      directory: deps.directory,
      operators: deps.operators,
    });
    deps.audit("bizcopilot.tenant_action_executed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      tenantId: "tenantId" in intent ? intent.tenantId : null,
    });
    return context;
  } catch (error) {
    deps.audit("bizcopilot.tenant_action_failed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      tenantId: "tenantId" in intent ? intent.tenantId : null,
      error: error instanceof Error ? error.message : String(error),
    });
    return [
      "BIZCOPILOT_TENANT_ERROR:",
      error instanceof Error ? error.message : "The tenant action failed.",
    ].join("\n");
  }
}

/**
 * Execute a parsed tenant intent through the Tenants page's own
 * routes, in-process. Returns the deterministic context block the
 * turn injects into the system prompt — success or failure, always
 * with the Tenants page link. Throws only on an unexpected
 * transport failure inside the handler; route-level failures
 * (401/403/404/400) are outcomes, returned as ERROR context.
 */
export async function executeBizCopilotTenantIntent(
  intent: BizCopilotTenantIntent,
  deps: BizCopilotTenantExecutorDeps,
): Promise<string> {
  if (!deps.userLogin) {
    return `BIZCOPILOT_TENANT_ERROR: ${JSON.stringify({
      action: intent.action,
      tenantId: "tenantId" in intent ? intent.tenantId : null,
      pageUrl: BIZCOPILOT_TENANTS_PAGE_URL,
      status: 401,
      error: { error: "Unauthorized: a signed-in session is required." },
    })}`;
  }

  if (intent.action === "membership-write-refused") {
    return `BIZCOPILOT_TENANT_RESULT: ${JSON.stringify({
      action: intent.action,
      tenantId: intent.tenantId,
      userId: intent.userId,
      pageUrl: BIZCOPILOT_TENANTS_PAGE_URL,
      refused: true,
      reason:
        "Membership changes are read-only in BizCopilot, exactly as on the Tenants page: IAAA writes belong to the CISO lane. The membership view itself is available — ask to show the tenant to see its members.",
    })}`;
  }

  if (intent.action === "list") {
    return resultContext(intent, await callTenantRoute("GET", "", undefined, deps));
  }

  if (intent.action === "create") {
    return resultContext(
      intent,
      await callTenantRoute("POST", "", { tenantId: intent.tenantId }, deps),
    );
  }

  if (intent.action === "detail" || intent.action === "settings-read") {
    return resultContext(
      intent,
      await callTenantRoute("GET", `/${encodeURIComponent(intent.tenantId)}`, undefined, deps),
    );
  }

  // settings-update: ads alone patches directly (no read needed);
  // auto-refresh / provider fields merge over the stored settings
  // read first — a partial command never invents the fields it
  // did not name (no hardcoded defaults: the stored row decides).
  const patch = intent.patch;
  if (
    patch.adsEnabled !== undefined &&
    patch.autoRefreshEnabled === undefined &&
    patch.autoRefreshIntervalS === undefined &&
    patch.dataProviderId === undefined &&
    patch.brokerId === undefined
  ) {
    return resultContext(
      intent,
      await callTenantRoute(
        "PATCH",
        `/${encodeURIComponent(intent.tenantId)}/settings`,
        { adsEnabled: patch.adsEnabled },
        deps,
      ),
    );
  }

  const current = await callTenantRoute(
    "GET",
    `/${encodeURIComponent(intent.tenantId)}`,
    undefined,
    deps,
  );
  if (!current.ok) return resultContext(intent, current);
  const settings = (current.body["tenant"] ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  if (patch.adsEnabled !== undefined) body["adsEnabled"] = patch.adsEnabled;
  if (patch.autoRefreshEnabled !== undefined || patch.autoRefreshIntervalS !== undefined) {
    body["autoRefresh"] = {
      enabled: patch.autoRefreshEnabled ?? settings["autoRefreshEnabled"],
      intervalS: patch.autoRefreshIntervalS ?? settings["autoRefreshIntervalS"],
    };
  }
  if (patch.dataProviderId !== undefined || patch.brokerId !== undefined) {
    body["providers"] = {
      dataProviderId: patch.dataProviderId ?? settings["dataProviderId"],
      brokerId: patch.brokerId ?? settings["brokerId"],
    };
  }
  return resultContext(
    intent,
    await callTenantRoute(
      "PATCH",
      `/${encodeURIComponent(intent.tenantId)}/settings`,
      body,
      deps,
    ),
  );
}
