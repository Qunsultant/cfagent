/**
 * Issue #1262 Phase 1 — channel identity intake.
 *
 * One contract for every inbound trading channel: a message arrives as a
 * ChannelIntake, `resolvePrincipal` maps it to a ChannelPrincipal (the
 * cfagent login it may act as, its DID, and its authority tier) — or to
 * null, in which case the channel replies with an explicit refusal. A
 * channel NEVER falls back to a shared instance identity (the synthetic
 * channel-name fallback tails this module replaces — the #1185 residual).
 *
 * Tiers: "read" (quote / screen / discovery / recommendation) <
 * "preview" (+ trade previews) < "trade" (+ approve / execute).
 *
 * Email: the principal map is the CHANNEL_EMAIL_PRINCIPALS config var
 * (JSON: lowercased sender address → { login, tier }) — plain
 * configuration read from env exactly like EMAIL_TO_ALLOWED_DOMAINS
 * (#143), not a credential. A trade-tier mapping additionally requires
 * a DKIM or SPF pass from the inbound Authentication-Results header;
 * without one the principal is downgraded to read tier for that message
 * and the downgrade reason rides along as `notice` so the reply can say
 * why. The #815 rule stands: the sender address never selects the
 * Orchestrator instance — the map establishes principal + tier only,
 * after routing.
 *
 * Slack: principals come from the connect-code link store
 * (team_id + user_id → { login, tier, linkedAt }) held in Durable
 * Object storage via the #329 store-KV client over the SESSION_STORE
 * namespace (DO, not KV — owner rule). Binding: the user DMs the bot
 * `link`, receives a short-lived single-use code (10 minutes), and
 * confirms it in an authenticated web session; the confirm binds the
 * code's Slack user to the SESSION's login at tier "trade"
 * (self-binding only). Unlinked Slack users resolve to null — v1
 * grants no default read tier, because workspace membership is not an
 * account relationship.
 *
 * Voice: the session login is the principal (tier "trade"); Phase 1
 * adopts the contract type only, behaviour unchanged.
 */

import type { Env } from "../../types";
import {
  createBucketPorts,
  isBucketPortsEnabled,
} from "../../data/createBucketPorts";
import { createStoreKv, consumeStoreKey, type DoNamespaceLike } from "../../data/durableKv";
import type { KvLike } from "../../security/kvResilience";
import type { executeNaturalLanguageQuery } from "../../agents/nlq";

/**
 * Issue #1262 Phase 4: the NLQ dependency set a channel service
 * threads into executeNaturalLanguageQuery — the web-chat set (scan +
 * profile stores, scheduling port, discovery runners) minus the
 * social-brief port, which web chat withholds from untrusted-origin
 * NLQ for the same reason (#1077 slice 2: a brief is a public-post
 * input). Built by the route (tradingIntegrations), never by the
 * services themselves, so the services stay constructible in tests.
 */
export type ChannelNlqDeps = NonNullable<Parameters<typeof executeNaturalLanguageQuery>[6]>;

export type ChannelKind = "email" | "slack" | "voice";

export type ChannelTier = "read" | "preview" | "trade";

export interface ChannelIntake {
  channel: ChannelKind;
  /** Email: the sender address. Slack: the Slack user id. Voice: the session login. */
  channelUserId: string;
  /** Slack: team_id (workspace scope of a link). Unused by email/voice. */
  channelScopeId?: string;
  text: string;
  /** Email only: DKIM/SPF outcome parsed from Authentication-Results. */
  authProof?: { dkimPass?: boolean; spfPass?: boolean };
}

export interface ChannelPrincipal {
  userLogin: string;
  authorizerDid: string;
  tier: ChannelTier;
  /**
   * Set when the resolved tier was reduced for this message (email
   * trade tier without a DKIM/SPF pass): the reply should state it.
   */
  notice?: string;
}

const TIER_RANK: Record<ChannelTier, number> = { read: 0, preview: 1, trade: 2 };

export function tierAtLeast(tier: ChannelTier, minimum: ChannelTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[minimum];
}

function isTier(value: unknown): value is ChannelTier {
  return value === "read" || value === "preview" || value === "trade";
}

// ---------------------------------------------------------------------------
// Email principal map (CHANNEL_EMAIL_PRINCIPALS)
// ---------------------------------------------------------------------------

export interface EmailPrincipalEntry {
  login: string;
  tier: ChannelTier;
}

/**
 * Parse the CHANNEL_EMAIL_PRINCIPALS config var. Malformed JSON is an
 * empty map plus a loud log — a config typo must fail closed (nobody
 * resolves) without ever throwing the worker. Individual malformed
 * entries are skipped the same way.
 */
export function parseEmailPrincipals(env: Env): Record<string, EmailPrincipalEntry> {
  const raw = (env as { CHANNEL_EMAIL_PRINCIPALS?: string }).CHANNEL_EMAIL_PRINCIPALS;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      "[channels] CHANNEL_EMAIL_PRINCIPALS is not valid JSON; treating the email principal map as empty:",
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[channels] CHANNEL_EMAIL_PRINCIPALS must be a JSON object; treating the email principal map as empty.");
    return {};
  }
  const out: Record<string, EmailPrincipalEntry> = {};
  for (const [address, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as { login?: unknown; tier?: unknown } | null;
    if (!e || typeof e.login !== "string" || e.login.trim() === "" || !isTier(e.tier)) {
      console.error(`[channels] CHANNEL_EMAIL_PRINCIPALS entry for "${address}" is malformed (needs {login, tier}); skipping it.`);
      continue;
    }
    out[address.trim().toLowerCase()] = { login: e.login, tier: e.tier };
  }
  return out;
}

/**
 * Extract DKIM/SPF pass results from an Authentication-Results header
 * value (RFC 8601). Anything other than an explicit `=pass` counts as
 * not passed.
 */
export function parseAuthenticationResults(header: string | undefined | null): { dkimPass: boolean; spfPass: boolean } {
  if (!header) return { dkimPass: false, spfPass: false };
  return {
    dkimPass: /(?:^|[\s;])dkim=pass(?=[\s;]|$)/i.test(header),
    spfPass: /(?:^|[\s;])spf=pass(?=[\s;]|$)/i.test(header),
  };
}

// ---------------------------------------------------------------------------
// Slack principal link store
// ---------------------------------------------------------------------------

export interface SlackPrincipalLink {
  login: string;
  tier: ChannelTier;
  linkedAt: string;
}

export interface SlackLinkCodeRecord {
  teamId: string;
  userId: string;
}

export interface SlackPrincipalLinkStore {
  getLink(teamId: string, userId: string): Promise<SlackPrincipalLink | null>;
  putLink(teamId: string, userId: string, link: SlackPrincipalLink): Promise<void>;
  /** Issue a connect code for (teamId, userId). `now` is injectable for tests. */
  issueLinkCode(teamId: string, userId: string, now?: number): Promise<{ code: string; expiresAt: number }>;
  /** Atomically consume a code: returns its Slack user exactly once. */
  consumeLinkCode(code: string, now?: number): Promise<SlackLinkCodeRecord | null>;
}

export const SLACK_LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const SLACK_LINK_STORE_NAMESPACE = "slack_principal_links";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity

function generateLinkCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normalizeLinkCode(code: string): string {
  return (code || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

interface LinkCodePayload extends SlackLinkCodeRecord {
  expiresAt: number;
}

/**
 * Build a link store over any string KV. `claim` (when provided) is the
 * atomic single-use guard used before the code record is deleted — the
 * DO-backed store passes the SessionStore consume op (#329), so two
 * racing confirms cannot both spend one code.
 */
export function createSlackPrincipalLinkStore(
  kv: KvLike,
  claim?: (key: string, value: string) => Promise<"consumed" | "duplicate" | "unavailable">
): SlackPrincipalLinkStore {
  const linkKey = (teamId: string, userId: string) => `link:${teamId}:${userId}`;
  const codeKey = (normalized: string) => `code:${normalized}`;

  return {
    async getLink(teamId, userId) {
      const raw = await kv.get(linkKey(teamId, userId));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as SlackPrincipalLink;
        if (typeof parsed.login !== "string" || !isTier(parsed.tier)) return null;
        return parsed;
      } catch {
        return null;
      }
    },

    async putLink(teamId, userId, link) {
      await kv.put(linkKey(teamId, userId), JSON.stringify(link));
    },

    async issueLinkCode(teamId, userId, now = Date.now()) {
      const code = generateLinkCode();
      const expiresAt = now + SLACK_LINK_CODE_TTL_MS;
      const payload: LinkCodePayload = { teamId, userId, expiresAt };
      await kv.put(codeKey(normalizeLinkCode(code)), JSON.stringify(payload), {
        expirationTtl: Math.ceil(SLACK_LINK_CODE_TTL_MS / 1000) + 60,
      });
      return { code, expiresAt };
    },

    async consumeLinkCode(code, now = Date.now()) {
      const normalized = normalizeLinkCode(code);
      if (normalized.length === 0) return null;
      const raw = await kv.get(codeKey(normalized));
      if (!raw) return null;
      let payload: LinkCodePayload;
      try {
        payload = JSON.parse(raw) as LinkCodePayload;
      } catch {
        return null;
      }
      if (!payload.teamId || !payload.userId || typeof payload.expiresAt !== "number") return null;
      if (now > payload.expiresAt) {
        await kv.delete(codeKey(normalized));
        return null;
      }
      if (claim) {
        const outcome = await claim(`code-claim:${normalized}`, "1");
        if (outcome !== "consumed") return null; // already spent, or store unreachable: fail closed
      }
      await kv.delete(codeKey(normalized));
      return { teamId: payload.teamId, userId: payload.userId };
    },
  };
}

/** In-memory link store (tests, local dev). Same semantics as the DO-backed store. */
export function createMemorySlackPrincipalLinkStore(): SlackPrincipalLinkStore {
  const map = new Map<string, string>();
  const kv: KvLike = {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return createSlackPrincipalLinkStore(kv);
}

/**
 * The production link store: the #329 DO-backed store client over the
 * SESSION_STORE namespace, bucket "slack_principal_links", with legacy
 * KV fallback disabled (the store is DO-only by design). When
 * SESSION_STORE is unbound the store reads as empty — resolution fails
 * closed (nobody is linked) rather than throwing.
 */
export function slackPrincipalLinkStoreFromEnv(env: Env): SlackPrincipalLinkStore {
  const namespace = (env as { SESSION_STORE?: unknown }).SESSION_STORE as DoNamespaceLike | undefined;
  // Issue #2436 (#1976 step 5e): when BUCKET_PORTS_ENABLED is
  // on, the link store composes through the residual bucket
  // family (bucket kv + the ClaimPort for the single-use code
  // claim) in src/data/createBucketPorts.ts; off, the direct
  // funnel composition below serves, unchanged. The claim's
  // outcomes stay distinct inside createSlackPrincipalLinkStore:
  // anything but "consumed" fails the spend closed.
  if (isBucketPortsEnabled(env)) {
    const ports = createBucketPorts(env);
    const claim = async (key: string, value: string) =>
      ports.claims.consume(
        SLACK_LINK_STORE_NAMESPACE,
        key,
        value,
        Math.ceil(SLACK_LINK_CODE_TTL_MS / 1000) + 60
      );
    return createSlackPrincipalLinkStore(ports.bucketKv("slackLinks"), claim);
  }
  const kv = createStoreKv({
    namespace: namespace ?? null,
    namespaceName: SLACK_LINK_STORE_NAMESPACE,
    legacyFallback: false,
  });
  const claim = async (key: string, value: string) =>
    consumeStoreKey({
      namespace: namespace ?? null,
      namespaceName: SLACK_LINK_STORE_NAMESPACE,
      key,
      value,
      ttlSeconds: Math.ceil(SLACK_LINK_CODE_TTL_MS / 1000) + 60,
    });
  return createSlackPrincipalLinkStore(kv, claim);
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

export interface ResolvePrincipalDeps {
  slackLinks?: SlackPrincipalLinkStore;
}

export async function resolvePrincipal(
  env: Env,
  intake: ChannelIntake,
  deps?: ResolvePrincipalDeps
): Promise<ChannelPrincipal | null> {
  switch (intake.channel) {
    case "email": {
      const address = (intake.channelUserId || "").trim().toLowerCase();
      if (!address) return null;
      const entry = parseEmailPrincipals(env)[address];
      if (!entry) return null;
      const principal: ChannelPrincipal = {
        userLogin: entry.login,
        authorizerDid: `did:user:email:${address}`,
        tier: entry.tier,
      };
      if (entry.tier === "trade" && !(intake.authProof?.dkimPass || intake.authProof?.spfPass)) {
        // A From header is trivially spoofable; the trade tier is only
        // as strong as the transport authentication behind this exact
        // message. Downgrade — never deny outright — and say why.
        principal.tier = "read";
        principal.notice =
          "Trade access was downgraded to read-only for this message because it did not pass DKIM/SPF authentication.";
      }
      return principal;
    }
    case "slack": {
      const teamId = (intake.channelScopeId || "").trim();
      const userId = (intake.channelUserId || "").trim();
      if (!teamId || !userId) return null;
      const store = deps?.slackLinks ?? slackPrincipalLinkStoreFromEnv(env);
      const link = await store.getLink(teamId, userId);
      if (!link) return null;
      return {
        userLogin: link.login,
        authorizerDid: `did:user:slack:${userId}`,
        tier: link.tier,
      };
    }
    case "voice": {
      const login = (intake.channelUserId || "").trim();
      if (!login) return null;
      return { userLogin: login, authorizerDid: `did:user:voice:${login}`, tier: "trade" };
    }
  }
}

// ---------------------------------------------------------------------------
// Connect-code confirm (authenticated web session side)
// ---------------------------------------------------------------------------

export type ConfirmSlackLinkResult =
  | { ok: true; teamId: string; userId: string; login: string; tier: ChannelTier }
  | { ok: false; error: string };

/**
 * Confirm a connect code for the signed-in session. The code names the
 * Slack user; the SESSION names the account — the binding written is
 * (team_id + user_id) → sessionLogin at tier "trade". A login supplied
 * by the caller is never accepted: self-binding only.
 */
export async function confirmSlackLink(
  env: Env,
  code: string,
  sessionLogin: string,
  deps?: ResolvePrincipalDeps
): Promise<ConfirmSlackLinkResult> {
  const login = (sessionLogin || "").trim();
  if (!login) return { ok: false, error: "An authenticated session is required to confirm a Slack link code." };
  if (!code || normalizeLinkCode(code).length === 0) return { ok: false, error: "A link code is required." };
  const store = deps?.slackLinks ?? slackPrincipalLinkStoreFromEnv(env);
  const record = await store.consumeLinkCode(code);
  if (!record) {
    return { ok: false, error: "That link code is invalid, expired, or already used. DM the bot `link` to get a fresh code." };
  }
  await store.putLink(record.teamId, record.userId, {
    login,
    tier: "trade",
    linkedAt: new Date().toISOString(),
  });
  return { ok: true, teamId: record.teamId, userId: record.userId, login, tier: "trade" };
}

// ---------------------------------------------------------------------------
// Channel-seam plan gates
// ---------------------------------------------------------------------------

/** The plan fields the channel seam gates on (structural — no NLQ import cycle). */
export interface ChannelPlanLike {
  domain?: string;
  tradingData?: { action?: string } | null;
  agenticPaymentsData?: { action?: string } | null;
}

/**
 * The channel seam's plan gate. Returns an explicit refusal message, or
 * null when the plan may proceed for this principal:
 *  - Channel-origin paid actions (paid_scan / paid_research) are
 *    refused in v1 for EVERY tier — a channel message must not spend
 *    money until channel identity has soaked (#183: the payer is the
 *    resolved principal or nobody).
 *  - Trade previews require tier >= "preview".
 *  - Direct order execution requires tier "trade".
 */
export function channelPlanRefusal(plan: ChannelPlanLike, principal: ChannelPrincipal): string | null {
  const paidAction = plan.domain === "agentic_payments" ? plan.agenticPaymentsData?.action : undefined;
  if (paidAction === "paid_scan" || paidAction === "paid_research") {
    return "Paid actions (paid scans and paid research) are not available from email or Slack yet — run them from the signed-in app. No payment was made.";
  }
  const action = plan.domain === "trading" ? plan.tradingData?.action : undefined;
  if (action === "preview_order" && !tierAtLeast(principal.tier, "preview")) {
    return `Trade previews require the preview tier or above; your channel principal (${principal.userLogin}) has ${principal.tier} access. No order draft was created.`;
  }
  if (action === "execute_order" && principal.tier !== "trade") {
    return `Executing an order requires the trade tier; your channel principal (${principal.userLogin}) has ${principal.tier} access. Nothing was executed.`;
  }
  return null;
}
