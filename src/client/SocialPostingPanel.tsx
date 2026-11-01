/**
 * Issue #1382: Social posting panel — brief editor, manual trigger, status readout.
 *
 * Issue #2149: tabbed shell page — the five sections are URL-synced tabs
 * (?view=) with visited tabs retained mounted-hidden, instead of one long
 * stacked scroll. Layout comes from primitives + token utilities only;
 * no inline-style layout, no bespoke page classes.
 *
 * Deliberately NO enable/disable control: the goal's enabled state is a
 * read-only readout, and a manual trigger runs the goal once without
 * enabling the daily schedule. The brief editor stores only what the user
 * types — with no stored brief it starts empty, never with invented text.
 * All reads/writes go through the existing session-gated routes.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Notice, PageShell, Tabs, TabPanel, TextInput } from "./components/ui";
import type { TabOption } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  listGoals,
  triggerGoal,
  type ScheduledGoal,
  type ScheduleTick,
} from "./scheduleApi";
import {
  DAILY_SOCIAL_POST_GOAL_ID,
  SOCIAL_BRIEF_MAX_CHARS,
  SOCIAL_CHANNEL_ORDER,
  getBrief,
  getTokenHealth,
  listPendingApprovals,
  saveBrief,
  todayInNewYork,
  listPosts,
  type ChannelTokenHealth,
  type PendingApproval,
  type SocialPostItem,
} from "./socialPostingApi";

const CHANNEL_LABELS: Record<string, string> = {
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

type SocialTab = "brief" | "goal" | "approvals" | "posts" | "tokens";

const SOCIAL_TABS: TabOption<SocialTab>[] = [
  { id: "brief", label: "Brief" },
  { id: "goal", label: "Goals" },
  { id: "approvals", label: "Approvals" },
  { id: "posts", label: "Posts" },
  { id: "tokens", label: "Token health" },
];

function isSocialTab(value: unknown): value is SocialTab {
  return (
    value === "brief" ||
    value === "goal" ||
    value === "approvals" ||
    value === "posts" ||
    value === "tokens"
  );
}

export function SocialPostingPanel({ active = true }: { active?: boolean }) {
  const [date] = useState(() => todayInNewYork());
  const [briefText, setBriefText] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [goal, setGoal] = useState<ScheduledGoal | null>(null);
  const [goalMissing, setGoalMissing] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [tokenChannels, setTokenChannels] = useState<Record<string, ChannelTokenHealth>>({});
  const [lastTick, setLastTick] = useState<ScheduleTick | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const fetchedRef = React.useRef(false);

  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<SocialTab>({
    param: "view",
    isValid: isSocialTab,
    defaultTab: "brief",
  });

  const refresh = useCallback(async () => {
    try {
      const [brief, goals, pending, health, postsRes] = await Promise.all([
        getBrief(date),
        listGoals(),
        listPendingApprovals(date),
        getTokenHealth(),
        listPosts(date).catch(() => ({ ok: false, date, posts: [] as SocialPostItem[] })),
      ]);
      setBriefText(brief.brief ?? "");
      const found = goals.goals.find((g) => g.id === DAILY_SOCIAL_POST_GOAL_ID);
      setGoal(found ?? null);
      setGoalMissing(!found);
      setApprovals(pending.approvals);
      setPosts(postsRes.posts ?? []);
      const channelMap: Record<string, ChannelTokenHealth> = {};
      if (Array.isArray(health.channels)) {
        for (const c of health.channels) {
          if (c && typeof c === "object" && (c as ChannelTokenHealth).channel) {
            channelMap[(c as ChannelTokenHealth).channel] = c as ChannelTokenHealth;
          }
        }
      } else if (health.channels && typeof health.channels === "object") {
        Object.assign(channelMap, health.channels);
      }
      setTokenChannels(channelMap);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load social posting status.");
    } finally {
      setLoading(false);
    }
  }, [date]);

  // Shell-retained pages mount once and stay mounted: fetch on first
  // activation (the old tab-render fetch), then only via refresh paths.
  useEffect(() => {
    if (active && !fetchedRef.current) {
      fetchedRef.current = true;
      void refresh();
    }
  }, [active, refresh]);

  const overCap = briefText.length > SOCIAL_BRIEF_MAX_CHARS;
  const canSave = briefText.trim().length > 0 && !overCap && !busy;

  const handleSave = async () => {
    if (!canSave) return;
    setBusy("save");
    setError("");
    try {
      const saved = await saveBrief(briefText, date);
      setSavedNote(`Brief saved for ${saved.date}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save brief.");
    } finally {
      setBusy("");
    }
  };

  const handleTrigger = async () => {
    if (busy || !goal) return;
    setBusy("trigger");
    setError("");
    try {
      const result = await triggerGoal(DAILY_SOCIAL_POST_GOAL_ID);
      setLastTick(result.tick);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trigger failed.");
    } finally {
      setBusy("");
    }
  };

  return (
    <PageShell
      title="Social Posting"
      scopeNote={`Today: ${date} · manual runs only — triggering never enables the daily schedule.`}
      loading={loading}
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!loading && (
        <>
          <Tabs
            tabs={SOCIAL_TABS}
            value={activeTab}
            onChange={handleTabChange}
            idBase="social"
            ariaLabel="Social Posting sections"
          />
          {visitedTabs.has("brief") && (
            <TabPanel idBase="social" tabId="brief" active={activeTab === "brief"} retain>
              <div className="ui-stack ui-narrow">
                <TextInput
                  multiline
                  rows={6}
                  placeholder="Write today's post here…"
                  value={briefText}
                  onChange={(e) => {
                    setBriefText(e.target.value);
                    setSavedNote("");
                  }}
                />
                <div className="ui-meta">
                  {briefText.length} / {SOCIAL_BRIEF_MAX_CHARS} characters
                  {overCap && (
                    <span className="ui-danger ui-ml-3">
                      Over the {SOCIAL_BRIEF_MAX_CHARS}-character cap — shorten the text to save.
                    </span>
                  )}
                </div>
                <div>
                  <Button variant="primary" disabled={!canSave} onClick={() => void handleSave()} loading={busy === "save"}>
                    {"Save brief"}
                  </Button>
                  {savedNote && <span className="ui-meta ui-success ui-ml-3">{savedNote}</span>}
                </div>
              </div>
            </TabPanel>
          )}
          {visitedTabs.has("goal") && (
            <TabPanel idBase="social" tabId="goal" active={activeTab === "goal"} retain>
              {goalMissing && (
                <div className="ui-meta">
                  The {DAILY_SOCIAL_POST_GOAL_ID} goal is not in the store yet.
                </div>
              )}
              {goal && (
                <div className="ui-narrow">
                  <Card>
                    <div className="ui-row">
                      <strong>{goal.name}</strong>
                      <code className="ui-meta-sm">{goal.id}</code>
                      <span className="ui-meta-sm">{goal.cron}</span>
                      <span className="ui-push">
                        <Badge tone={goal.enabled ? "success" : "neutral"} size="sm">
                          {goal.enabled ? "ENABLED" : "DISABLED"}
                        </Badge>
                      </span>
                    </div>
                    <div className="ui-meta ui-mt-1">
                      operation <code>{goal.operation}</code> · budget ${(goal.budgetCents / 100).toFixed(2)} · last
                      run {goal.lastRun ? new Date(goal.lastRun).toLocaleString() : "never"}
                    </div>
                    <div className="ui-row ui-mt-2">
                      <Button variant="primary" disabled={!!busy} onClick={() => void handleTrigger()}>
                        Run now
                      </Button>
                    </div>
                    {lastTick && (
                      <div className="ui-meta ui-mt-2">
                        Last manual run: {new Date(lastTick.timestamp).toLocaleString()} — evaluated{" "}
                        {lastTick.goalsEvaluated}, created {lastTick.jobsCreated}, skipped {lastTick.jobsSkipped}
                        {lastTick.errors.length > 0 && (
                          <div className="ui-danger ui-mt-1">
                            {lastTick.errors.map((e, i) => (
                              <div key={i}>{e}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </TabPanel>
          )}
          {visitedTabs.has("approvals") && (
            <TabPanel idBase="social" tabId="approvals" active={activeTab === "approvals"} retain>
              {approvals.length === 0 && (
                <div className="ui-meta">No pending approvals for {date}.</div>
              )}
              <div className="ui-stack-lg ui-narrow">
                {approvals.map((a) => (
                  <Card key={a.draftId}>
                    <div className="ui-row">
                      <strong>{CHANNEL_LABELS[a.channel] ?? a.channel}</strong>
                      <span className="ui-meta-sm">{a.status}</span>
                      <span className="ui-meta-sm ui-push">
                        {new Date(a.requestedAtMs).toLocaleString()}
                      </span>
                    </div>
                    <div className="ui-meta ui-mt-1">{a.text}</div>
                  </Card>
                ))}
              </div>
            </TabPanel>
          )}
          {visitedTabs.has("posts") && (
            <TabPanel idBase="social" tabId="posts" active={activeTab === "posts"} retain>
              {posts.length === 0 && (
                <div className="ui-meta">No submitted posts or drafts for {date}.</div>
              )}
              <div className="ui-stack-lg ui-narrow">
                {posts.map((p) => {
                  const label = CHANNEL_LABELS[p.channel] ?? p.channel;
                  const isPosted = p.status === "posted";
                  const isDryRun = p.status === "dry-run-posted";
                  return (
                    <Card key={p.draftId}>
                      <div className="ui-row ui-mb-1-5">
                        <strong>{label}</strong>
                        <Badge tone={isPosted ? "success" : isDryRun ? "accent" : "neutral"} size="sm">
                          {p.status.toUpperCase()}
                        </Badge>
                        {p.platformPostId && (
                          <code className="ui-meta-sm">ID: {p.platformPostId}</code>
                        )}
                        <span className="ui-meta-sm ui-push">
                          {new Date(p.createdAtMs).toLocaleString()}
                        </span>
                      </div>
                      <div className="ui-meta ui-mb-1">
                        <span>Submission endpoint: </span>
                        <code>{p.submissionEndpoint || "—"}</code>
                      </div>
                      <div className="ui-meta ui-mb-1-5">
                        <span>Submitted post URL: </span>
                        {p.postUrl ? (
                          <a
                            href={p.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ui-link"
                          >
                            {p.postUrl}
                          </a>
                        ) : (
                          <span className="ui-meta-sm">
                            {isDryRun ? "Dry run (simulated — not submitted to live platform)" : "Pending submission"}
                          </span>
                        )}
                      </div>
                      <div className="ui-meta ui-mt-1">{p.text}</div>
                    </Card>
                  );
                })}
              </div>
            </TabPanel>
          )}
          {visitedTabs.has("tokens") && (
            <TabPanel idBase="social" tabId="tokens" active={activeTab === "tokens"} retain>
              {SOCIAL_CHANNEL_ORDER.filter((id) => tokenChannels[id]).map((id) => {
                const channel = tokenChannels[id];
                return (
                  <div key={id} className="ui-meta ui-mb-1-5">
                    <strong>{CHANNEL_LABELS[id] ?? id}</strong> —{" "}
                    {channel.presence === "configured" ? "Configured" : "Not configured"} · validity{" "}
                    {channel.validity === "valid"
                      ? "Valid"
                      : channel.validity === "invalid"
                        ? "Invalid"
                        : "Unknown"}
                  </div>
                );
              })}
              <div className="ui-meta-sm ui-mt-1">
                Validity reads Unknown in production by design: no live probe is wired, so validity is
                never assumed — only a real post proves a token works.
              </div>
            </TabPanel>
          )}
        </>
      )}
    </PageShell>
  );
}
