/**
 * #1771 (parent #1717) slice D: social feed wiring — the screener
 * digest → brief decision, implemented as mechanism (not automation).
 *
 * Decision terms (slice A, unchanged here): the digest is an OPT-IN
 * feed source behind ONE scoped switch; the built-in default is
 * today's behavior (human/NLQ brief only); a human brief for the
 * same date ALWAYS wins and is never overwritten; a digest-derived
 * brief is provenance-marked as auto-generated; live publish still
 * requires the existing approval standing, and the #1224 pipeline
 * gates stay byte-identical.
 *
 * What this module does and does NOT do:
 * - DOES: resolve the feed source (run > session > user > global
 *   env > built-in "brief-only"; an invalid winning value fails
 *   closed to "brief-only" with invalid=true — never to digest),
 *   build a digest brief from a screener outcome (refusing to
 *   mint one from an outcome with no symbols and no headline),
 *   and stage that brief into the SAME brief store the pipeline
 *   feed stage already reads — but ONLY when no brief exists
 *   for the date. Staging is the wiring: the next
 *   pipeline:social-daily firing picks it up through its normal
 *   feed stage; no pipeline code is changed here.
 * - DOES NOT: wire an automatic tick. No screener-outcome feed
 *   into the social tick exists on main, so no caller here
 *   invents one: an operator or scheduled goal calls
 *   stageDigestBrief with a real screener outcome before the
 *   pipeline firing. That remaining caller wiring is recorded
 *   in the doc as the follow-up, not claimed as done.
 * - NEVER: overwrite a human brief, mint content the outcome
 *   did not contain, or publish anything. Drafts and delivery
 *   remain the pipeline's approval-gated stages.
 */

export const SOCIAL_FEED_SOURCE_SWITCH = "SOCIAL_FEED_SOURCE" as const;

export type SocialFeedSource = "brief-only" | "screener-digest";

export interface SocialFeedSourceLevels {
  run?: string | null;
  session?: string | null;
  user?: string | null;
  globalEnv?: string | null;
}

export interface ResolvedSocialFeedSource {
  source: SocialFeedSource;
  level: "run" | "session" | "user" | "globalEnv" | "built-in";
  invalid: boolean;
}

function normalizeSocialFeedSource(raw: string): SocialFeedSource | null {
  const v = raw.trim().toLowerCase();
  if (v === "brief-only" || v === "brief_only" || v === "brief") return "brief-only";
  if (v === "screener-digest" || v === "screener_digest" || v === "digest") return "screener-digest";
  return null;
}

/** Scoped resolution, run > session > user > global env > built-in. First non-blank level wins; invalid wins fail closed to "brief-only". */
export function resolveSocialFeedSource(levels: SocialFeedSourceLevels): ResolvedSocialFeedSource {
  const ordered: Array<[ResolvedSocialFeedSource["level"], string | null | undefined]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["globalEnv", levels.globalEnv],
  ];
  for (const [level, raw] of ordered) {
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = normalizeSocialFeedSource(raw);
      if (parsed === null) return { source: "brief-only", level, invalid: true };
      return { source: parsed, level, invalid: false };
    }
  }
  return { source: "brief-only", level: "built-in", invalid: false };
}

export interface ScreenerDigestOutcome {
  date: string;
  kind: string;
  symbols?: string[];
  headline?: string;
  reportUrl?: string;
}

/** Build a provenance-marked digest brief, or null when the outcome carries nothing to brief (never mint empty content). */
export function buildDigestBrief(outcome: ScreenerDigestOutcome): string | null {
  const symbols = (outcome.symbols ?? []).map((s) => s.trim()).filter(Boolean);
  const headline = (outcome.headline ?? "").trim();
  if (symbols.length === 0 && headline === "") return null;
  const parts = [`[auto-generated from screener digest ${outcome.date} (${outcome.kind})]`];
  if (headline !== "") parts.push(headline);
  if (symbols.length > 0) parts.push(`Screen: ${symbols.join(", ")}.`);
  if (outcome.reportUrl) parts.push(`Report: ${outcome.reportUrl}`);
  return parts.join(" ");
}

export interface DigestBriefStore {
  getBrief(date: string): Promise<string | null>;
  putBrief(date: string, text: string): Promise<void>;
}

export type StageDigestBriefResult =
  | { staged: true }
  | { staged: false; reason: "human-brief-present" | "no-digest" | "digest-disabled" };

/**
 * Stage a digest brief for the date, human-brief-wins: if the store
 * already holds a brief (human/NLQ-supplied, or an earlier digest),
 * NOTHING is overwritten. Digest-disabled (resolved source is not
 * screener-digest) stages nothing — the switch, not the caller,
 * decides whether digests may feed the brief store.
 */
export async function stageDigestBrief(
  store: DigestBriefStore,
  outcome: ScreenerDigestOutcome,
  source: SocialFeedSource,
): Promise<StageDigestBriefResult> {
  if (source !== "screener-digest") return { staged: false, reason: "digest-disabled" };
  const digest = buildDigestBrief(outcome);
  if (digest === null) return { staged: false, reason: "no-digest" };
  const existing = await store.getBrief(outcome.date);
  if (existing !== null && existing.trim() !== "") {
    return { staged: false, reason: "human-brief-present" };
  }
  await store.putBrief(outcome.date, digest);
  return { staged: true };
}
