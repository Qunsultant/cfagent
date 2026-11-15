/**
 * Issue #4516 (BizCopilot slice 2, umbrella #4514) — account
 * administration through the BizCopilot chat tab, extending the
 * slice-1 tenant branch (src/services/bizCopilotTenants.ts) with
 * the same deterministic shape: the turn's BizCopilot branch
 * parses the user's text for the account activities (lookup /
 * operator subscription grant / unlimited-free grant+revoke /
 * free-access grant+revoke / per-customer version move / grant
 * history) and executes them by calling the SAME server paths
 * the Accounts page uses — handlePlatformAccountRoutes for the
 * lookup, handleAgenticPaymentsRoutes for the commercial
 * account, plans, subscription grant, free-access, products,
 * and version move — in-process, with the same store-operator
 * gate, session-scoped identity, and audit as the page path.
 * No second implementation, no new server capability, no
 * change to the Accounts page.
 *
 * The branch runs in OrchestratorAgent.portBeforeTurn (the
 * auto-options-research branch's shape): the deterministic
 * result is injected into the system prompt as retrieved
 * content and the model only narrates it (activeTools: []),
 * exactly as the auto-research job context is narrated.
 *
 * BOUNDED WAIT (#4513): the chat account path never fetches.
 * The executor calls the route handlers in-process against the
 * D1 ports — a fixed small number of store calls, the same
 * calls the page path makes, no polling, no retries, no
 * unbounded loop. A failure anywhere surfaces as an explicit
 * BIZCOPILOT_ACCOUNT_ERROR outcome, never a silent spin.
 *
 * GRANTS STAY SELECTIVE (owner decisions, #3241/#3245/#3247):
 * a grant is made only when an operator asks for it through
 * chat, under the same store-operator gate as the page path.
 * No grant is made to any real account except on such an
 * explicit operator request, and no grant is activated or
 * seeded anywhere else. Tests use in-memory fakes only.
 *
 * CONSERVATIVE PARSING: only explicit commands parse. Anything
 * ambiguous, partial, or unrecognized returns null and the turn
 * proceeds as a normal LLM turn — the model may ask for
 * clarification, but no mutation is ever guessed. A grant whose
 * required reason or expiry is missing parses, and the
 * executor returns a deterministic error naming what is
 * missing — the target is unambiguous, so the failure is an
 * explicit outcome, never a guessed write.
 *
 * RSI posture (slice 1): BizCopilot turns already flow through
 * the generic evaluation path (judge.evaluate + VectorMemory in
 * portOnChatResponse) and the turn audit records every executed
 * action (bizcopilot.account_action_executed/failed). Behavior
 * changes only through governed adoption (code change + CI),
 * never silently — the governed RSI loop's observation step is
 * the audit trail, and adoption is a PR.
 */

import { handlePlatformAccountRoutes } from "../agents/routes/platformAccounts";
import { handleAgenticPaymentsRoutes } from "../agents/routes/agenticPayments";
import {
  COMMERCIAL_BARE_BASE,
  commercialBarePath,
} from "../data/commercialUrlCatalog";
import {
  resolveEffectiveVersion,
  type VersionLike,
} from "../data/productPorts";
import type { DatabaseORM } from "../orm";
import type { Env } from "../types";
import { BIZCOPILOT_REGISTRATION_ID } from "./bizCopilotTenants";
import { copilotRegistrationForSourceTab } from "./copilotChannels";

/** The Accounts page every BizCopilot account result links, so the user can open and verify what was done. */
export const BIZCOPILOT_ACCOUNTS_PAGE_URL =
  "https://agent.openaimp.com/?tab=platform-admin&view=accounts";

export type BizCopilotAccountIntent =
  | { action: "lookup"; userId: string }
  | { action: "grant-subscription"; userId: string; planRef: string }
  | {
      action: "grant-unlimited-free";
      userId: string;
      reason: string | null;
      expiresRaw: string | null;
    }
  | { action: "revoke-unlimited-free"; userId: string }
  | {
      action: "grant-free-access";
      userId: string;
      kind: "lifetime" | "limited";
      reason: string | null;
      expiresRaw: string | null;
    }
  | { action: "revoke-free-access"; userId: string }
  | { action: "grant-history"; userId: string }
  | { action: "move-current-pricing"; userId: string; reason: string | null };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
}

/**
 * Parse one account command. Returns null for anything that is not
 * an explicit account command — the turn then proceeds normally.
 */
export function parseBizCopilotAccountIntent(
  text: string,
): BizCopilotAccountIntent | null {
  const raw = normalize(text);
  if (!raw) return null;

  // Lookup: "show account <login>", "look up account <login>",
  // "show subscriptions for <login>".
  const lookup =
    /^(?:show|display|get|look up|lookup)(?: me)? (?:the )?account(?: for)? (\S+)$/i.exec(raw) ??
    /^(?:show|display)(?: me)? (?:the )?subscriptions(?: for)? (\S+)$/i.exec(raw);
  if (lookup) return { action: "lookup", userId: lookup[1] };

  // Grant history: "show grants for <login>", "show grant history for <login>".
  const history =
    /^(?:show|display|get)(?: me)? (?:the )?grants?(?: history)? (?:for|of) (\S+)$/i.exec(raw);
  if (history) return { action: "grant-history", userId: history[1] };

  // Unlimited-free grant: "grant unlimited free to <login> [until <date>] [because <reason>]".
  // The reason and expiry are captured raw; the executor validates
  // them and returns a deterministic error when one is missing —
  // a reason is never invented.
  const unlimitedFree =
    /^grant unlimited[- ]?free to (\S+)(?: until (\S+))?(?: because (.+))?$/i.exec(raw);
  if (unlimitedFree) {
    return {
      action: "grant-unlimited-free",
      userId: unlimitedFree[1],
      expiresRaw: unlimitedFree[2] ?? null,
      reason: unlimitedFree[3]?.trim() ? unlimitedFree[3].trim() : null,
    };
  }

  // Unlimited-free revoke: "revoke unlimited free from <login>".
  const revokeUnlimited =
    /^revoke unlimited[- ]?free (?:from|for) (\S+)$/i.exec(raw);
  if (revokeUnlimited) {
    return { action: "revoke-unlimited-free", userId: revokeUnlimited[1] };
  }

  // Free-access grant: "grant free access <lifetime|limited> to <login> [until <date>] [because <reason>]".
  const freeAccess =
    /^grant free[- ]?access (lifetime|limited) to (\S+)(?: until (\S+))?(?: because (.+))?$/i.exec(raw);
  if (freeAccess) {
    return {
      action: "grant-free-access",
      userId: freeAccess[2],
      kind: freeAccess[1].toLowerCase() as "lifetime" | "limited",
      expiresRaw: freeAccess[3] ?? null,
      reason: freeAccess[4]?.trim() ? freeAccess[4].trim() : null,
    };
  }

  // Free-access revoke: "revoke free access from <login>".
  const revokeFreeAccess =
    /^revoke free[- ]?access (?:from|for) (\S+)$/i.exec(raw);
  if (revokeFreeAccess) {
    return { action: "revoke-free-access", userId: revokeFreeAccess[1] };
  }

  // Operator subscription grant: "grant <plan> subscription to <login>"
  // (also "grant subscription <plan> to <login>"). The plan is named
  // or given by id; the executor resolves it against GET /plans and
  // refuses an unknown or ambiguous name — never guesses a plan.
  const grantByName =
    /^grant (.+?) subscription to (\S+)$/i.exec(raw) ??
    /^grant subscription (.+?) to (\S+)$/i.exec(raw);
  if (grantByName) {
    return {
      action: "grant-subscription",
      userId: grantByName[2],
      planRef: grantByName[1].trim(),
    };
  }

  // Per-customer version move: "move <login> to current pricing [because <reason>]".
  const move =
    /^move (?:account )?(\S+) to current pricing(?: because (.+))?$/i.exec(raw);
  if (move) {
    return {
      action: "move-current-pricing",
      userId: move[1],
      reason: move[2]?.trim() ? move[2].trim() : null,
    };
  }

  return null;
}

export interface BizCopilotAccountDeps {
  /** Worker env — the same env the HTTP dispatch passes (the handlers this executor calls require the full worker Env; on these paths they read only the AGENT_DB binding and the store-operator list). */
  env: Env;
  /** The turn's verified login (from the session, never client-supplied) — the operator identity the routes gate on. */
  userLogin: string;
  /** ORM accessor — the commercial handler requires it (its usage-billing branch only); the account paths never call it. */
  getOrm: () => DatabaseORM;
  /** Audit funnel (the branch's 2-arg shape; adapted to each handler's 3-arg ctx.audit below). */
  audit: (type: string, payload: Record<string, unknown>) => void;
}

type AccountRouteResult = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
};

function failedResult(status: number, error: string): AccountRouteResult {
  return { ok: false, status, body: { error } };
}

function buildRequest(
  method: string,
  url: URL,
  login: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-login": login,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readRouteResult(
  response: Response | null,
  unmatchedError: string,
): Promise<AccountRouteResult> {
  if (!response) return failedResult(500, unmatchedError);
  const parsed = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  return { ok: response.ok, status: response.status, body: parsed ?? {} };
}

/** Call the platform lookup route in-process, exactly as the Accounts page's lookup does. */
async function callLookup(
  deps: BizCopilotAccountDeps,
  userId: string,
): Promise<AccountRouteResult> {
  const url = new URL(
    `https://bizcopilot.internal/platform/accounts/lookup?userId=${encodeURIComponent(userId)}`,
  );
  const response = await handlePlatformAccountRoutes(
    buildRequest("GET", url, deps.userLogin),
    url,
    url.pathname,
    "bizcopilot-chat",
    {
      env: deps.env,
      audit: (_type, _agent, payload) =>
        deps.audit(_type, payload as Record<string, unknown>),
    },
  );
  return readRouteResult(response, "Account lookup did not match a route.");
}

/** Call one commercial route in-process, exactly as the Accounts page's sections do. */
async function callCommercial(
  deps: BizCopilotAccountDeps,
  method: "GET" | "POST",
  routeId: string,
  query: Record<string, string>,
  body?: unknown,
): Promise<AccountRouteResult> {
  const bare = commercialBarePath(routeId);
  const url = new URL(`https://bizcopilot.internal${bare}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await handleAgenticPaymentsRoutes(
    buildRequest(method, url, deps.userLogin, body),
    url,
    bare,
    "bizcopilot-chat",
    {
      env: deps.env,
      getOrm: deps.getOrm,
      audit: (type, _agent, payload) =>
        deps.audit(type, payload as Record<string, unknown>),
    },
  );
  return readRouteResult(response, "The commercial route did not match.");
}

/** Call the per-subscription version-move route (bare path, same template the Accounts page's move section uses). */
async function callMove(
  deps: BizCopilotAccountDeps,
  subscriptionId: string,
  toVersionId: string,
  reason: string | null,
): Promise<AccountRouteResult> {
  const bare = `${COMMERCIAL_BARE_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}/move`;
  const url = new URL(`https://bizcopilot.internal${bare}`);
  const response = await handleAgenticPaymentsRoutes(
    buildRequest("POST", url, deps.userLogin, {
      toVersionId,
      ...(reason ? { reason } : {}),
    }),
    url,
    bare,
    "bizcopilot-chat",
    {
      env: deps.env,
      getOrm: deps.getOrm,
      audit: (type, _agent, payload) =>
        deps.audit(type, payload as Record<string, unknown>),
    },
  );
  return readRouteResult(response, "The version-move route did not match.");
}

/**
 * Parse an "until <date>" token into a future expiry, or report the
 * problem deterministically. Returns null for "no expiry named"
 * (valid for the unlimited-free grant, which may be open-ended).
 */
function parseFutureExpiry(
  expiresRaw: string | null,
): { expiresAtMs: number | null } | { error: string } {
  if (!expiresRaw) return { expiresAtMs: null };
  const parsed = Date.parse(expiresRaw);
  if (!Number.isFinite(parsed)) {
    return { error: `Could not read the expiry date "${expiresRaw}". Use a date such as 2027-01-01.` };
  }
  if (parsed <= Date.now()) {
    return { error: `The expiry date "${expiresRaw}" is in the past. Use a future date.` };
  }
  return { expiresAtMs: parsed };
}

function resultContext(
  intent: BizCopilotAccountIntent,
  result: AccountRouteResult,
): string {
  const payload = {
    action: intent.action,
    userId: intent.userId,
    pageUrl: BIZCOPILOT_ACCOUNTS_PAGE_URL,
    ...(result.ok
      ? { result: result.body }
      : { status: result.status, error: result.body }),
  };
  return result.ok
    ? `BIZCOPILOT_ACCOUNT_RESULT: ${JSON.stringify(payload)}`
    : `BIZCOPILOT_ACCOUNT_ERROR: ${JSON.stringify(payload)}`;
}

/**
 * Execute a parsed account intent through the Accounts page's own
 * routes, in-process. Returns the deterministic context block the
 * turn injects into the system prompt — success or failure, always
 * with the Accounts page link. Throws only on an unexpected
 * transport failure inside a handler; route-level failures
 * (401/403/404/400) are outcomes, returned as ERROR context.
 */
export async function executeBizCopilotAccountIntent(
  intent: BizCopilotAccountIntent,
  deps: BizCopilotAccountDeps,
): Promise<string> {
  // Every intent starts with the Accounts page lookup — the same
  // gate (store operator) and existence check the page performs
  // before any section loads.
  const lookup = await callLookup(deps, intent.userId);
  if (!lookup.ok) return resultContext(intent, lookup);
  if (intent.action === "lookup") return resultContext(intent, lookup);

  // Mutating and history intents need an existing commercial
  // account; the grant routes would refuse without one, but the
  // lookup's own message names the fix (the operator creates the
  // account first).
  const identity = lookup.body.identity as Record<string, unknown> | undefined;
  if (identity?.hasAccount !== true) {
    return resultContext(
      intent,
      failedResult(
        400,
        `No commercial account for user ${intent.userId}. The operator creates the account first.`,
      ),
    );
  }

  if (intent.action === "grant-subscription") {
    // Resolve the plan by name or id against GET /plans — the
    // effective version per product for the operator's segment,
    // the same list the page shows the operator. An unknown or
    // ambiguous name is a deterministic error, never a guess.
    const plans = await callCommercial(deps, "GET", "plans", {});
    if (!plans.ok) return resultContext(intent, plans);
    const list = (plans.body.plans ?? []) as Array<Record<string, unknown>>;
    const wanted = intent.planRef.toLowerCase();
    const matches = list.filter(
      (plan) =>
        (typeof plan.name === "string" &&
          plan.name.toLowerCase() === wanted) ||
        (typeof plan.id === "string" && plan.id.toLowerCase() === wanted),
    );
    if (matches.length === 0) {
      const names = list
        .map((plan) => String(plan.name ?? plan.id))
        .join(", ");
      return resultContext(
        intent,
        failedResult(
          404,
          `No plan named "${intent.planRef}". Available plans: ${names || "none"}.`,
        ),
      );
    }
    if (matches.length > 1) {
      const names = matches
        .map((plan) => String(plan.name ?? plan.id))
        .join(", ");
      return resultContext(
        intent,
        failedResult(
          400,
          `More than one plan matches "${intent.planRef}": ${names}. Name one plan.`,
        ),
      );
    }
    const plan = matches[0] as { id: string };
    return resultContext(
      intent,
      await callCommercial(deps, "POST", "subscriptionGrant", {}, {
        userId: intent.userId,
        planId: plan.id,
      }),
    );
  }

  if (intent.action === "grant-unlimited-free") {
    if (!intent.reason) {
      return resultContext(
        intent,
        failedResult(
          400,
          "An unlimited-free grant needs a reason — say why this account is approved for free access, for example: grant unlimited free to alice@example.com because approved by the tenant admin.",
        ),
      );
    }
    const expiry = parseFutureExpiry(intent.expiresRaw);
    if ("error" in expiry) {
      return resultContext(intent, failedResult(400, expiry.error));
    }
    // The upsert re-sends the record's current values, exactly as
    // the page's unlimited-free section does — only the grant
    // changes. grantedBy is overwritten server-side from the
    // session login.
    const record = await callCommercial(deps, "GET", "account", {
      userId: intent.userId,
    });
    if (!record.ok) return resultContext(intent, record);
    const current = record.body.record as Record<string, unknown>;
    return resultContext(
      intent,
      await callCommercial(deps, "POST", "account", {}, {
        userId: intent.userId,
        tenantId: current.tenantId,
        tier: current.tier,
        creditsUSD: current.creditsUSD,
        includedRuns: current.includedRuns,
        unlimitedFreeGrant: {
          grantedBy: deps.userLogin,
          reason: intent.reason,
          expiresAtMs: expiry.expiresAtMs,
        },
      }),
    );
  }

  if (intent.action === "revoke-unlimited-free") {
    const record = await callCommercial(deps, "GET", "account", {
      userId: intent.userId,
    });
    if (!record.ok) return resultContext(intent, record);
    const current = record.body.record as Record<string, unknown>;
    if (!current.unlimitedFreeGrant) {
      return resultContext(
        intent,
        failedResult(
          404,
          `No unlimited-free grant is active for user ${intent.userId}.`,
        ),
      );
    }
    return resultContext(
      intent,
      await callCommercial(deps, "POST", "account", {}, {
        userId: intent.userId,
        tenantId: current.tenantId,
        tier: current.tier,
        creditsUSD: current.creditsUSD,
        includedRuns: current.includedRuns,
        unlimitedFreeGrant: null,
      }),
    );
  }

  if (intent.action === "grant-free-access") {
    if (!intent.reason) {
      return resultContext(
        intent,
        failedResult(
          400,
          "A free-access grant needs a reason — say why this account is approved for free access, for example: grant free access lifetime to alice@example.com because approved by the tenant admin.",
        ),
      );
    }
    if (intent.kind === "limited" && !intent.expiresRaw) {
      return resultContext(
        intent,
        failedResult(
          400,
          "A limited-time free-access grant needs an expiry date — say until when, for example: grant free access limited to alice@example.com until 2027-01-01 because approved for a trial.",
        ),
      );
    }
    if (intent.kind === "lifetime" && intent.expiresRaw) {
      return resultContext(
        intent,
        failedResult(
          400,
          "A lifetime free-access grant has no expiry date — drop the until date, or ask for a limited grant instead.",
        ),
      );
    }
    const expiry = parseFutureExpiry(intent.expiresRaw);
    if ("error" in expiry) {
      return resultContext(intent, failedResult(400, expiry.error));
    }
    return resultContext(
      intent,
      await callCommercial(deps, "POST", "freeAccessGrant", {}, {
        userId: intent.userId,
        kind: intent.kind,
        expiresAtMs: expiry.expiresAtMs,
        reason: intent.reason,
      }),
    );
  }

  if (intent.action === "revoke-free-access") {
    // The route itself reports 404 when no grant is active.
    return resultContext(
      intent,
      await callCommercial(deps, "POST", "freeAccessRevoke", {}, {
        userId: intent.userId,
      }),
    );
  }

  if (intent.action === "grant-history") {
    const freeAccess = await callCommercial(deps, "GET", "freeAccess", {
      userId: intent.userId,
    });
    if (!freeAccess.ok) return resultContext(intent, freeAccess);
    const record = await callCommercial(deps, "GET", "account", {
      userId: intent.userId,
    });
    if (!record.ok) return resultContext(intent, record);
    const current = record.body.record as Record<string, unknown>;
    return resultContext(intent, {
      ok: true,
      status: 200,
      body: {
        subscriptions: lookup.body.subscriptions ?? [],
        freeAccess: freeAccess.body,
        unlimitedFreeGrant: current.unlimitedFreeGrant ?? null,
      },
    });
  }

  // move-current-pricing: every live subscription (the codebase's
  // own live notion — active with a future period end, per the
  // version-move primitives) moves to the effective version for
  // the holder's segment; already-current and unresolvable rows
  // are reported per subscription, never skipped silently.
  const record = await callCommercial(deps, "GET", "account", {
    userId: intent.userId,
  });
  if (!record.ok) return resultContext(intent, record);
  const segment = String(
    (record.body.record as Record<string, unknown>)?.segment ?? "default",
  );
  const productsRes = await callCommercial(deps, "GET", "products", {});
  if (!productsRes.ok) return resultContext(intent, productsRes);
  const products = (productsRes.body.products ?? []) as Array<{
    product: Record<string, unknown>;
    versions: Array<Record<string, unknown>>;
  }>;
  const versionsByProduct = new Map<string, VersionLike[]>();
  const productByVersion = new Map<string, string>();
  for (const entry of products) {
    const productId = String(entry.product?.id ?? "");
    const versions = (entry.versions ?? []) as unknown as VersionLike[];
    versionsByProduct.set(productId, versions);
    for (const version of versions) {
      productByVersion.set(String(version.id), productId);
    }
  }
  const nowMs = Date.now();
  const subscriptions = (lookup.body.subscriptions ?? []) as Array<
    Record<string, unknown>
  >;
  const moves: Array<Record<string, unknown>> = [];
  for (const subscription of subscriptions) {
    const subscriptionId = String(subscription.id ?? "");
    const planId = String(subscription.planId ?? "");
    const live =
      subscription.status === "active" &&
      typeof subscription.periodEndMs === "number" &&
      subscription.periodEndMs > nowMs;
    if (!live) {
      moves.push({
        subscriptionId,
        planId,
        moved: false,
        outcome: "skipped-not-live",
        status: subscription.status ?? null,
      });
      continue;
    }
    const productId = productByVersion.get(planId);
    if (!productId) {
      moves.push({
        subscriptionId,
        planId,
        moved: false,
        outcome: "no-product-for-plan",
      });
      continue;
    }
    const target = resolveEffectiveVersion(
      versionsByProduct.get(productId) ?? [],
      segment,
      nowMs,
    );
    if (!target) {
      moves.push({
        subscriptionId,
        planId,
        moved: false,
        outcome: "no-effective-version",
      });
      continue;
    }
    if (target.id === planId) {
      moves.push({
        subscriptionId,
        planId,
        fromVersionId: planId,
        toVersionId: planId,
        moved: false,
        outcome: "already-current",
      });
      continue;
    }
    const moved = await callMove(
      deps,
      subscriptionId,
      target.id,
      intent.reason,
    );
    if (!moved.ok) {
      moves.push({
        subscriptionId,
        planId,
        fromVersionId: planId,
        toVersionId: target.id,
        moved: false,
        outcome: "move-failed",
        error: (moved.body as Record<string, unknown>).error ?? moved.body,
      });
      continue;
    }
    moves.push({
      subscriptionId,
      planId,
      fromVersionId: planId,
      toVersionId: target.id,
      moved: Boolean((moved.body as Record<string, unknown>).moved),
      outcome: "moved",
    });
  }
  return resultContext(intent, {
    ok: true,
    status: 200,
    body: { moves },
  });
}

/**
 * The BizCopilot turn branch (called from
 * OrchestratorAgent.portBeforeTurn): on a BizCopilot turn whose
 * text parses as an explicit account command, execute it
 * deterministically through the Accounts page's own routes and
 * return the outcome context for the system prompt. Returns ""
 * when the turn is not a BizCopilot account command — the turn
 * then proceeds normally. Route-level failures are outcomes in
 * the returned context, never thrown; only an unexpected
 * transport failure inside the handler throws, and the caller
 * turns it into an ERROR context.
 */
export async function runBizCopilotAccountBranch(deps: {
  sourceTab?: string;
  userText: string;
  env: Env;
  userLogin: string;
  getOrm: () => DatabaseORM;
  audit: (type: string, payload: Record<string, unknown>) => void;
}): Promise<string> {
  if (copilotRegistrationForSourceTab(deps.sourceTab) !== BIZCOPILOT_REGISTRATION_ID) return "";
  const intent = parseBizCopilotAccountIntent(deps.userText);
  if (!intent) return "";
  try {
    const context = await executeBizCopilotAccountIntent(intent, {
      env: deps.env,
      userLogin: deps.userLogin,
      getOrm: deps.getOrm,
      audit: deps.audit,
    });
    deps.audit("bizcopilot.account_action_executed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      userId: intent.userId,
    });
    return context;
  } catch (error) {
    deps.audit("bizcopilot.account_action_failed", {
      sourceTab: deps.sourceTab,
      action: intent.action,
      userId: intent.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [
      "BIZCOPILOT_ACCOUNT_ERROR:",
      error instanceof Error ? error.message : "The account action failed.",
    ].join("\n");
  }
}
