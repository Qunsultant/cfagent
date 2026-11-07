/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — approved-free
 * per-service quota section for the Billing servicing tab.
 *
 * The quota bounds the operator-granted unlimited-free entitlement
 * (#3245) with a per-service cap per period plus the grant's
 * limited-time window. Every value shown is operator data read
 * from the server (migrations 0054 tables + 0055 PROPOSED seeds);
 * no quota number, window, or at-limit action is hardcoded here.
 * At the limit the user is asked to upgrade or buy credits
 * (pay-per-use) — #3241 decision 4, decided by the owner — or,
 * where the operator set "stop", no further runs are available
 * under the grant. A default cap applies unless the operator sets
 * otherwise, so an operator grant is capped, never unlimited.
 *
 * Operator-only editing: the section probes operator status the
 * same way #2985 does (GET /operators succeeds => operator) and
 * offers the editor only then; the server routes remain the access
 * control. After every action the section re-reads the quota and
 * renders only the fresh read, never the POST answer — the POST
 * answer contributes only its catalog-coded success NOTE.
 * Failures surface as the server's catalog business message when
 * the server sent a code, else fixed status-keyed strings, never
 * raw server text.
 *
 * AOP (#2381, #2573): success notes and action errors render the
 * catalog message resolved by the server; the expired grant
 * renders FAILURE_APPROVED_FREE_QUOTA_EXPIRED from the catalog
 * (never-granted keeps "No approved-free grant for this
 * account."). Client-side pre-submit hints ("Enter a non-negative
 * whole number...") are fixed UI copy for input that never
 * reaches the server — no outcome is emitted for them.
 *
 * Accessibility (WCAG 2.2 AA, tech-standards §10): the section
 * title is an h2 under the Billing h1; every input carries a
 * label (TextInput/Select primitives); errors render in a Notice
 * (danger/warning → role="alert") and success notes in a Notice
 * (info → role="status"), so both are announced; all status is
 * text, never color-only; focus rings come from the primitives.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through approvedFreeQuotaApi.ts (the #71 rule).
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Notice, Select, Stack, TextInput } from "./components/ui";
import {
  getApprovedFreeQuota,
  isGrantExpired,
  isStoreOperator,
  setApprovedFreeQuotaCap,
  setApprovedFreeQuotaSettings,
  ApprovedFreeQuotaApiError,
  type ApprovedFreeQuotaAtLimitAction,
  type ApprovedFreeQuotaFamily,
  type ApprovedFreeQuotaState,
  type ApprovedFreeQuotaWindowKind,
} from "./approvedFreeQuotaApi";
import { codedMessage } from "../outcomes/outcomeAspects";
import { APPROVED_FREE_QUOTA_FAMILIES } from "../data/approvedFreeQuotaPorts";

/** Display labels, same words as the price catalogue's family list. */
const FAMILY_LABELS: Record<ApprovedFreeQuotaFamily, string> = {
  stock: "Stock",
  goal: "Goal",
  options: "Options",
  strategy: "Strategy",
};

const WINDOW_LABELS: Record<ApprovedFreeQuotaWindowKind, string> = {
  month: "per month",
  week: "per week",
};

function statusOf(err: unknown): number {
  return err instanceof ApprovedFreeQuotaApiError ? err.status : 0;
}

function loadMessage(err: unknown): string {
  // AOP: a catalog-coded server body renders its business message;
  // otherwise the fixed status-keyed string.
  if (err instanceof ApprovedFreeQuotaApiError && err.code && err.serverMessage) {
    return err.serverMessage;
  }
  const status = statusOf(err);
  if (status === 401) return "Sign in to view the approved-free quota.";
  if (status === 403) return "You do not have access to this account's approved-free quota.";
  if (status === 503) return "The approved-free quota store is unavailable right now.";
  return "Could not load the approved-free quota.";
}

function actionMessage(err: unknown): string {
  if (err instanceof ApprovedFreeQuotaApiError && err.code && err.serverMessage) {
    return err.serverMessage;
  }
  const status = statusOf(err);
  if (status === 400) return "That quota value was not accepted. Check the value and try again.";
  if (status === 403) return "Only a store operator can change the approved-free quota.";
  if (status === 503) return "The approved-free quota store is unavailable right now.";
  return "The approved-free quota could not be updated.";
}

function quotaStatus(row: ApprovedFreeQuotaState["families"][number], windowKind: string): string {
  if (row.cap === null) return "No cap set — no approved-free runs for this service.";
  if (row.cap === 0) return `0 runs ${windowKind} — approved-free runs disabled for this service.`;
  const remaining = row.remaining ?? 0;
  return `${row.used} of ${row.cap} runs used ${windowKind} — ${remaining} remaining.`;
}

export function ApprovedFreeQuotaSection() {
  const [state, setState] = useState<ApprovedFreeQuotaState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [viewedUserId, setViewedUserId] = useState("");
  const [lookupDraft, setLookupDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [windowDraft, setWindowDraft] = useState<ApprovedFreeQuotaWindowKind>("month");
  const [actionDraft, setActionDraft] = useState<ApprovedFreeQuotaAtLimitAction>("upgrade_or_buy_credits");
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const applyState = useCallback((fresh: ApprovedFreeQuotaState) => {
    setState(fresh);
    setViewedUserId(fresh.userId);
    setDrafts(
      Object.fromEntries(fresh.families.map((row) => [row.family, row.cap === null ? "" : String(row.cap)])),
    );
    if (fresh.settings) {
      setWindowDraft(fresh.settings.windowKind);
      setActionDraft(fresh.settings.atLimitAction);
    }
  }, []);

  const load = useCallback(
    async (userId?: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const [quotaResult, operatorResult] = await Promise.allSettled([
          getApprovedFreeQuota(userId),
          isStoreOperator(),
        ]);
        if (quotaResult.status === "fulfilled") {
          applyState(quotaResult.value);
        } else {
          setState(null);
          setLoadError(loadMessage(quotaResult.reason));
        }
        // Operators success alone proves operator status. Any
        // failure (including a transient outage) falls back to the
        // read-only view; the server still refuses any action the
        // UI should not offer.
        setIsOperator(operatorResult.status === "fulfilled" && operatorResult.value === true);
      } catch {
        setState(null);
        setLoadError(loadMessage(null));
        setIsOperator(false);
      } finally {
        setLoading(false);
      }
    },
    [applyState],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const saveCap = useCallback(
    async (family: ApprovedFreeQuotaFamily) => {
      const raw = (drafts[family] ?? "").trim();
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 0) {
        setNote(`Enter a non-negative whole number of runs for ${FAMILY_LABELS[family]}.`);
        return;
      }
      setSaving(`cap-${family}`);
      setNote("");
      setActionError(null);
      try {
        const { message } = await setApprovedFreeQuotaCap(family, parsed);
        const fresh = await getApprovedFreeQuota(viewedUserId || undefined);
        applyState(fresh);
        // The note is the POST's catalog-coded success message, not
        // a hand-written variant — the fresh read above is the state.
        setNote(message);
      } catch (err) {
        setActionError(actionMessage(err));
      } finally {
        setSaving(null);
      }
    },
    [drafts, viewedUserId, applyState],
  );

  const saveWindow = useCallback(async () => {
    setSaving("window");
    setNote("");
    setActionError(null);
    try {
      const { message } = await setApprovedFreeQuotaSettings({ windowKind: windowDraft });
      const fresh = await getApprovedFreeQuota(viewedUserId || undefined);
      applyState(fresh);
      setNote(message);
    } catch (err) {
      setActionError(actionMessage(err));
    } finally {
      setSaving(null);
    }
  }, [windowDraft, viewedUserId, applyState]);

  const saveAction = useCallback(async () => {
    setSaving("action");
    setNote("");
    setActionError(null);
    try {
      const { message } = await setApprovedFreeQuotaSettings({ atLimitAction: actionDraft });
      const fresh = await getApprovedFreeQuota(viewedUserId || undefined);
      applyState(fresh);
      setNote(message);
    } catch (err) {
      setActionError(actionMessage(err));
    } finally {
      setSaving(null);
    }
  }, [actionDraft, viewedUserId, applyState]);

  const lookup = useCallback(async () => {
    const userId = lookupDraft.trim();
    if (!userId) {
      setNote("Enter an account login to look up.");
      return;
    }
    setNote("");
    setActionError(null);
    await load(userId);
  }, [lookupDraft, load]);

  return (
    <Card>
      <h2>Approved-free quota</h2>
      {loading && <p>Loading approved-free quota</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={() => void load(viewedUserId || undefined)}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && state && (
        <Stack gap="1" data-testid="approved-free-quota-panel">
          <p>
            The per-service cap on the operator-granted unlimited-free entitlement. Each service
            (stock, goal, options, strategy) gets its own cap per period; at the cap the user is
            asked to upgrade or buy credits, unless the operator set the at-limit action to stop.
            Caps are operator data — a grant with no cap set gets no approved-free runs.
          </p>
          {state.grant.active ? (
            <p>
              Approved-free grant: active
              {state.grant.expiresAtMs !== null
                ? ` until ${new Date(state.grant.expiresAtMs).toLocaleDateString()}`
                : " with no expiry set"}
              .
            </p>
          ) : isGrantExpired(state.grant) ? (
            <p>{codedMessage("FAILURE_APPROVED_FREE_QUOTA_EXPIRED")}</p>
          ) : (
            <p>No approved-free grant for this account.</p>
          )}
          {isOperator && (
            <>
              <TextInput
                label="Look up an account (login)"
                value={lookupDraft}
                onChange={(event) => setLookupDraft(event.target.value)}
              />
              <div>
                <Button onClick={() => void lookup()}>Look up quota</Button>
              </div>
              <p>Viewing quota for: {viewedUserId}</p>
            </>
          )}
          {APPROVED_FREE_QUOTA_FAMILIES.map((family) => {
            const row = state.families.find((entry) => entry.family === family);
            const windowKind = state.settings ? WINDOW_LABELS[state.settings.windowKind] : "per period";
            return (
              <div key={family}>
                <div>
                  <strong>{FAMILY_LABELS[family]}:</strong>{" "}
                  {row ? quotaStatus(row, windowKind) : "No quota row for this service."}
                </div>
                {isOperator && (
                  <>
                    <TextInput
                      label={`${FAMILY_LABELS[family]} cap (runs ${windowKind})`}
                      value={drafts[family] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [family]: event.target.value }))
                      }
                    />
                    <div>
                      <Button onClick={() => void saveCap(family)} loading={saving === `cap-${family}`}>
                        Save {FAMILY_LABELS[family]} cap
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {isOperator && state.settings && (
            <>
              <Select
                label="Quota window"
                value={windowDraft}
                onChange={(event) =>
                  setWindowDraft(event.target.value as ApprovedFreeQuotaWindowKind)
                }
              >
                <option value="month">Per month</option>
                <option value="week">Per week</option>
              </Select>
              <div>
                <Button onClick={() => void saveWindow()} loading={saving === "window"}>
                  Save quota window
                </Button>
              </div>
              <Select
                label="At the limit"
                value={actionDraft}
                onChange={(event) =>
                  setActionDraft(event.target.value as ApprovedFreeQuotaAtLimitAction)
                }
              >
                <option value="upgrade_or_buy_credits">Ask to upgrade or buy credits</option>
                <option value="stop">Stop — no further runs under the grant</option>
              </Select>
              <div>
                <Button onClick={() => void saveAction()} loading={saving === "action"}>
                  Save at-limit action
                </Button>
              </div>
            </>
          )}
          {!isOperator && <p>Only a store operator can change the approved-free quota.</p>}
          {note && <Notice tone="info">{note}</Notice>}
          {actionError && <Notice tone="danger">{actionError}</Notice>}
        </Stack>
      )}
    </Card>
  );
}
