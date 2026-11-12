/**
 * Issue #1382: client API for the social posting panel.
 *
 * Reuses the existing session-gated routes only — no new backend routes.
 * Same-origin fetch carries the session cookie, exactly as in jobsApi.
 * The brief editor stores only what the user types; this module never
 * invents content.
 */
import { withCsrfInit } from "./apiFetch";

/** Server cap (src/agents/social/briefStore.ts SOCIAL_BRIEF_MAX_CHARS). */
export const SOCIAL_BRIEF_MAX_CHARS = 4000;

/** The ScheduledAgent goal the panel triggers (never enables/disables). */
export const DAILY_SOCIAL_POST_GOAL_ID = "daily-social-post";

/** Fixed display order for token-health rows, independent of response order. */
export const SOCIAL_CHANNEL_ORDER = ["threads", "x", "facebook", "instagram", "linkedin"] as const;

export type SocialChannelId = (typeof SOCIAL_CHANNEL_ORDER)[number];

export interface PendingApproval {
  date: string;
  channel: string;
  draftId: string;
  requestedAtMs: number;
  text: string;
  status: string;
}

export interface ChannelTokenHealth {
  channel: string;
  tokenEnvVar: string;
  accountEnvVar?: string;
  presence: "configured" | "unconfigured";
  accountPresence?: "configured" | "unconfigured";
  validity: "valid" | "invalid" | "unknown";
  validated: boolean;
  validationEndpoint: string | null;
  validationEndpointConfirmed: boolean;
}

/** Today's wall-clock date in America/New_York, matching the server default. */
export function todayInNewYork(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(path, withCsrfInit(init));
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

export function getBrief(date: string = todayInNewYork()) {
  return api<{ ok: boolean; date: string; brief: string | null }>(
    `/api/social/brief?date=${encodeURIComponent(date)}`,
  );
}

export function saveBrief(text: string, date: string = todayInNewYork()) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Brief text must be a non-empty string.");
  }
  if (text.length > SOCIAL_BRIEF_MAX_CHARS) {
    throw new Error(`Brief text must be ${SOCIAL_BRIEF_MAX_CHARS} characters or fewer.`);
  }
  return api<{ ok: boolean; date: string }>("/api/social/brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, date }),
  });
}

export function listPendingApprovals(date: string = todayInNewYork()) {
  return api<{ ok: boolean; date: string; approvals: PendingApproval[] }>(
    `/api/social/approvals?date=${encodeURIComponent(date)}`,
  );
}

export async function getTokenHealth(): Promise<{
  ok: boolean;
  channels: Record<string, ChannelTokenHealth>;
  rawChannels: ChannelTokenHealth[];
}> {
  const data = await api<{
    ok: boolean;
    channels: ChannelTokenHealth[] | Record<string, ChannelTokenHealth>;
  }>("/api/social/token-health");

  const byChannel: Record<string, ChannelTokenHealth> = {};
  const rawChannels: ChannelTokenHealth[] = [];

  if (Array.isArray(data.channels)) {
    for (const c of data.channels) {
      if (c && typeof c === "object" && c.channel) {
        byChannel[c.channel] = c;
        rawChannels.push(c);
      }
    }
  } else if (data.channels && typeof data.channels === "object") {
    Object.assign(byChannel, data.channels);
    rawChannels.push(...Object.values(data.channels));
  }

  return { ok: data.ok, channels: byChannel, rawChannels };
}

export interface SocialPostItem {
  channel: string;
  draftId: string;
  date: string;
  status: string;
  text: string;
  platformPostId?: string | null;
  submissionEndpoint: string;
  postUrl: string | null;
  createdAtMs: number;
  approval?: {
    approver: string;
    approvedAtMs: number;
  };
}

export function listPosts(date: string = todayInNewYork()) {
  return api<{ ok: boolean; date: string; posts: SocialPostItem[] }>(
    `/api/social/posts?date=${encodeURIComponent(date)}`,
  );
}

