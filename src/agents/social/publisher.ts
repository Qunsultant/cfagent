/**
 * #1077 Phase 5a — social publisher layer (token-independent).
 *
 * One publisher definition per channel: its token env var, its publish
 * endpoint, and a payload builder from draft text. Payload shapes follow
 * each platform's documented publish API, but NOTHING here has been
 * proven against a live platform — no live call exists in this phase,
 * and the shapes must be re-confirmed against current platform docs
 * before the first live post (Phase 5b).
 *
 * Honest gaps, stated rather than papered over:
 * - Threads and Instagram publish in TWO steps (create a container,
 *   then publish it). Both steps are implemented and threaded through
 *   the injected transport, so a fake transport proves the sequence.
 * - Facebook uses /me/feed, which resolves to the Page only when the
 *   token is a Page token; the account mapping that guarantees this is
 *   a Phase 5b input.
 * - LinkedIn requires an author URN in the payload, so its definition
 *   declares an account env var (LINKEDIN_AUTHOR_URN). Without it the
 *   publish fails closed BEFORE any transport call — a LinkedIn post
 *   must never be attempted with a guessed author.
 *
 * Transport injection: publishers never call the real fetch. They take
 * a SocialTransport, so tests use a fake and production code in this
 * phase never touches a platform host. A live transport is a Phase 5b
 * wiring step, behind the resolution rule below.
 *
 * Resolution rule (defense in depth):
 * - Posting OFF (SOCIAL_POSTING_ENABLED unset/not "1"/"true") →
 *   unavailable: nothing publishes at all, not even a dry run.
 * - Live requested (posting ON + SOCIAL_LIVE_PUBLISHING "1"/"true"):
 *   token present (and account id present when required) → live
 *   adapter; token or account id missing → UNAVAILABLE with a clear
 *   error. A failed live gate is NEVER silently downgraded to a
 *   dry run: an operator who asked for live must see the failure.
 * - Live NOT requested → DryRunPublisher. Dry-run is the default.
 * - Unknown channel → unavailable, always.
 * The agent itself may never flip these flags at runtime; they are
 * config, read per call from the passed env/tokens.
 */

import type { SocialChannel } from "./config";
import { resolveEnvironmentConfig } from "../../config/environment";
import type { Env } from "../../types";
import type { SocialDraft } from "./draft";

export interface SocialTransportResponse {
  status: number;
  body: unknown;
}

/** Minimal transport surface: one POST. Tests inject a fake; no global fetch. */
export interface SocialTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<SocialTransportResponse>;
}

export interface ChannelPublisherDef {
  channel: SocialChannel;
  /** Env var name holding this channel's token (Worker secret in production). */
  tokenEnvVar: string;
  /** Env var name holding an account id the payload needs, if any. */
  accountEnvVar?: string;
  /** First-step publish endpoint. */
  endpoint: string;
  buildPayload: (text: string, accountId?: string) => Record<string, unknown>;
  /** Post id from a successful response body (data.id for X, id elsewhere). */
  extractPostId: (body: unknown) => string | undefined;
  /** Second-step endpoint + payload builder (container publish for Threads/IG). */
  buildSecondStep?: (firstId: string) => { endpoint: string; payload: Record<string, unknown> };
}

function bodyId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function dataId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (typeof data === "object" && data !== null) {
    const id = (data as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return bodyId(body);
}

export const CHANNEL_PUBLISHERS: Record<SocialChannel, ChannelPublisherDef> = {
  x: {
    channel: "x",
    tokenEnvVar: "X_ACCESS_TOKEN",
    endpoint: "https://api.twitter.com/2/tweets",
    buildPayload: (text) => ({ text }),
    extractPostId: dataId,
  },
  threads: {
    channel: "threads",
    tokenEnvVar: "THREADS_ACCESS_TOKEN",
    endpoint: "https://graph.threads.net/v1.0/me/threads",
    buildPayload: (text) => ({ media_type: "TEXT", text }),
    extractPostId: bodyId,
    buildSecondStep: (firstId) => ({
      endpoint: "https://graph.threads.net/v1.0/me/threads_publish",
      payload: { creation_id: firstId },
    }),
  },
  facebook: {
    channel: "facebook",
    tokenEnvVar: "FACEBOOK_PAGE_ACCESS_TOKEN",
    endpoint: "https://graph.facebook.com/v21.0/me/feed",
    buildPayload: (text) => ({ message: text }),
    extractPostId: bodyId,
  },
  instagram: {
    channel: "instagram",
    tokenEnvVar: "INSTAGRAM_ACCESS_TOKEN",
    endpoint: "https://graph.instagram.com/v21.0/me/media",
    buildPayload: (text) => ({ caption: text }),
    extractPostId: bodyId,
    buildSecondStep: (firstId) => ({
      endpoint: "https://graph.instagram.com/v21.0/me/media_publish",
      payload: { creation_id: firstId },
    }),
  },
  linkedin: {
    channel: "linkedin",
    tokenEnvVar: "LINKEDIN_ACCESS_TOKEN",
    accountEnvVar: "LINKEDIN_AUTHOR_URN",
    endpoint: "https://api.linkedin.com/v2/ugcPosts",
    buildPayload: (text, accountId) => ({
      author: accountId,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
    extractPostId: bodyId,
  },
};

export function getPublisherDef(channel: string): ChannelPublisherDef | undefined {
  const id = channel.trim().toLowerCase();
  // Own-property check, as in draft.ts: `in` would match inherited
  // Object.prototype names and let garbage channels through.
  if (!Object.prototype.hasOwnProperty.call(CHANNEL_PUBLISHERS, id)) return undefined;
  return CHANNEL_PUBLISHERS[id as SocialChannel];
}

export type PublishResult =
  | { ok: true; platformPostId: string }
  | { ok: false; error: string };

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** Extract diagnostic error message from platform response body (#1489). */
export function extractResponseErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") {
    return body.trim();
  }
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string" && b.error.trim()) return b.error.trim();
  if (typeof b.error === "object" && b.error !== null) {
    const err = b.error as Record<string, unknown>;
    if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
  }
  if (typeof b.detail === "string" && b.detail.trim()) return b.detail.trim();
  if (typeof b.message === "string" && b.message.trim()) return b.message.trim();
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const firstErr = b.errors[0];
    if (typeof firstErr === "string" && firstErr.trim()) return firstErr.trim();
    if (
      typeof firstErr === "object" &&
      firstErr !== null &&
      typeof (firstErr as Record<string, unknown>).message === "string"
    ) {
      return ((firstErr as Record<string, unknown>).message as string).trim();
    }
  }
  return undefined;
}

/**
 * Run one channel's publish steps over the injected transport. Never
 * throws: transport failures and non-2xx responses become error
 * results, so one channel's failure can never take down a batch.
 * No transport call is attempted when the token or required account
 * id is missing — the fail-closed gate runs before any fetch.
 */
export async function publishWithPublisher(
  def: ChannelPublisherDef | undefined,
  input: {
    token: string | undefined;
    accountId?: string;
    text: string;
    transport: SocialTransport;
  },
): Promise<PublishResult> {
  if (!def) return { ok: false, error: "unknown social channel" };
  if (isBlank(input.token)) {
    return { ok: false, error: `missing token for ${def.channel} (set ${def.tokenEnvVar})` };
  }
  if (def.accountEnvVar && isBlank(input.accountId)) {
    return {
      ok: false,
      error: `missing account id for ${def.channel} (set ${def.accountEnvVar})`,
    };
  }
  const headers = {
    Authorization: `Bearer ${input.token!.trim()}`,
    "Content-Type": "application/json",
  };
  try {
    const first = await input.transport.post(
      def.endpoint,
      headers,
      JSON.stringify(def.buildPayload(input.text, input.accountId)),
    );
    if (first.status < 200 || first.status >= 300) {
      const detail = extractResponseErrorDetail(first.body);
      return {
        ok: false,
        error: `publish failed for ${def.channel}: HTTP ${first.status}${detail ? ` — ${detail}` : ""}`,
      };
    }
    const firstId = def.extractPostId(first.body);
    if (!def.buildSecondStep) {
      if (!firstId) {
        const detail = extractResponseErrorDetail(first.body);
        return {
          ok: false,
          error: `publish failed for ${def.channel}: no post id returned${detail ? ` — ${detail}` : ""}`,
        };
      }
      return { ok: true, platformPostId: firstId };
    }
    if (!firstId) {
      const detail = extractResponseErrorDetail(first.body);
      return {
        ok: false,
        error: `publish failed for ${def.channel}: no container id returned${detail ? ` — ${detail}` : ""}`,
      };
    }
    const second = def.buildSecondStep(firstId);
    const secondRes = await input.transport.post(
      second.endpoint,
      headers,
      JSON.stringify(second.payload),
    );
    if (secondRes.status < 200 || secondRes.status >= 300) {
      const detail = extractResponseErrorDetail(secondRes.body);
      return {
        ok: false,
        error: `publish failed for ${def.channel}: HTTP ${secondRes.status}${detail ? ` — ${detail}` : ""}`,
      };
    }
    const postId = def.extractPostId(secondRes.body) ?? firstId;
    return { ok: true, platformPostId: postId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `publish transport failed for ${def.channel}: ${message}` };
  }
}

/** One dry-run publish attempt, for audit and tests. */
export interface DryRunRecord {
  channel: string;
  draftId: string;
  text: string;
  recordedAtMs: number;
}

export interface DryRunSink {
  record(entry: DryRunRecord): void;
}

export function createMemoryDryRunSink(): DryRunSink & { records: DryRunRecord[] } {
  const records: DryRunRecord[] = [];
  return {
    records,
    record(entry: DryRunRecord) {
      records.push(entry);
    },
  };
}

/**
 * Records the attempt and reports success with a synthetic id. It
 * never touches the network and never reads a token — that is the
 * whole point of the dry-run default.
 */
export class DryRunPublisher {
  constructor(private readonly sink: DryRunSink) {}

  publish(draft: SocialDraft, nowMs: number): { ok: true; platformPostId: string } {
    this.sink.record({
      channel: draft.channel,
      draftId: draft.id,
      text: draft.text,
      recordedAtMs: nowMs,
    });
    return { ok: true, platformPostId: `dry-run:${draft.id}` };
  }
}

/** Env subset the publisher layer reads: config flags only, never tokens. */
export interface PublishEnv {
  SOCIAL_POSTING_ENABLED?: string;
  SOCIAL_LIVE_PUBLISHING?: string;
  [key: string]: string | undefined;
}

export type PublishTarget =
  | { kind: "live"; def: ChannelPublisherDef }
  | { kind: "dry-run"; publisher: DryRunPublisher }
  | { kind: "unavailable"; error: string };

// Phase 3 (#6550): both flags live in environment.config.json
// (defaults.social); a still-set env var wins.
function isLiveRequested(env: PublishEnv): boolean {
  return resolveEnvironmentConfig(env as Partial<Env> | undefined).workerSettings.social
    .livePublishing;
}

function isPostingEnabled(env: PublishEnv): boolean {
  return resolveEnvironmentConfig(env as Partial<Env> | undefined).workerSettings.social
    .postingEnabled;
}

/**
 * Resolve what a publish attempt may use. Tokens arrive as a separate
 * record (never read from the config env here), so production wiring
 * passes the Worker's token env vars explicitly and Phase 5a tests
 * pass fakes. See the module docstring for the full rule.
 */
export function resolvePublishTarget(
  channel: string,
  input: {
    env: PublishEnv;
    tokens: Record<string, string | undefined>;
    dryRunSink: DryRunSink;
  },
): PublishTarget {
  if (!isPostingEnabled(input.env)) {
    return { kind: "unavailable", error: "social posting is not enabled" };
  }
  const def = getPublisherDef(channel);
  if (!def) return { kind: "unavailable", error: `unknown social channel: ${channel}` };
  if (!isLiveRequested(input.env)) {
    return { kind: "dry-run", publisher: new DryRunPublisher(input.dryRunSink) };
  }
  const token = input.tokens[def.tokenEnvVar];
  if (isBlank(token)) {
    return { kind: "unavailable", error: `missing token for ${def.channel} (set ${def.tokenEnvVar})` };
  }
  if (def.accountEnvVar && isBlank(input.tokens[def.accountEnvVar])) {
    return {
      kind: "unavailable",
      error: `missing account id for ${def.channel} (set ${def.accountEnvVar})`,
    };
  }
  return { kind: "live", def };
}

/**
 * Platform API endpoint where posts are submitted.
 */
export function resolveSubmissionEndpoint(channel: string): string {
  switch (channel.toLowerCase()) {
    case "threads":
      return "https://graph.threads.net/v1.0/me/threads_publish";
    case "x":
      return "https://api.twitter.com/2/tweets";
    case "facebook":
      return "https://graph.facebook.com/v21.0/me/feed";
    case "instagram":
      return "https://graph.instagram.com/v21.0/me/media_publish";
    case "linkedin":
      return "https://api.linkedin.com/v2/ugcPosts";
    default:
      return "";
  }
}

/**
 * Public web permalink where a submitted post is live.
 */
export function resolvePostUrl(channel: string, platformPostId?: string | null): string | null {
  if (!platformPostId || typeof platformPostId !== "string" || !platformPostId.trim()) {
    return null;
  }
  const id = platformPostId.trim();
  switch (channel.toLowerCase()) {
    case "threads":
      return `https://www.threads.net/t/${encodeURIComponent(id)}`;
    case "x":
      return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
    case "facebook":
      return `https://www.facebook.com/${encodeURIComponent(id)}`;
    case "instagram":
      return `https://www.instagram.com/p/${encodeURIComponent(id)}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}`;
    default:
      return null;
  }
}
