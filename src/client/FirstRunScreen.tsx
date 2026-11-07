/**
 * Issue #3256 (sub-issue of #3241, program #2218) — Signup → Trial
 * onboarding flow. Extends #2471's screen from 4 steps to 5; it
 * does not replace the #2471 screen's contract (same Modal, same
 * onComplete/onDismiss, same localStorage fallback).
 *
 * Guided steps: (1) create your account, (2) try a free trial,
 * (3) connect your brokerage, (4) notification preferences, (5)
 * setup summary. Built ONLY from src/client/components/ui/
 * primitives with token-only styling (ux-architecture §20): no
 * bespoke classes, no inline styles.
 *
 * REAL, not fluff — every step does what it says:
 * - Step 1 calls POST /platform/accounts/setup on entry when no
 *   account exists (idempotent, session-scoped) and advances only
 *   on a real success; an existing account is shown, never
 *   recreated. No tenant input exists anywhere.
 * - Step 2 lists plans with a trial (listPlans) and starts one via
 *   the #3243 $0 trial route (subscriptionTrial). Trial is a
 *   CHOICE: "Skip trial for now" advances without starting one.
 *   No trial offered anywhere means an honest "none available".
 * - Step 3 shows LIVE E*TRADE status from the status endpoint.
 *   "Connect E*TRADE" navigates to the real OAuth start
 *   (/api/etrade/oauth/start?mode=redirect) after persisting the
 *   current step server-side, so the flow resumes after the
 *   callback. "Continue without connecting" is an explicit honest
 *   path — the summary then records brokerage as not connected.
 *   The old "open-settings-menu" event is NOT used anywhere here:
 *   step 2 of #2471 pointed at Settings; this flow connects for
 *   real or says it did not.
 * - Step 4 is the NotificationPreferencesPanel over the existing
 *   lifecycle preferences route (now unblocked: step 1 created the
 *   account, so tenantId is non-null).
 * - Step 5 is a TRUE summary re-fetched from the server (identity
 *   + self account view + live brokerage status): account, tier,
 *   credits, included runs, trial status from the trial
 *   subscription row, brokerage status, and preferences saved
 *   state. A claim appears ONLY when the server said so — the
 *   approved-free quota block shows per-service remaining (#3263)
 *   and nothing is invented.
 *
 * Step progress is persisted server-side (saveOnboardingState) on
 * every advance so the gate can resume at the saved step. Finish
 * marks server-side completion and keeps the localStorage flag as
 * fallback (#2471).
 *
 * Failure policy (#462 partial contract, typed never silent): an
 * identity load failure shows a fixed caller-facing error and
 * offers Continue to hub via onDismiss — it never skips silently
 * into the hub, and never marks completion on failure.
 */
import React, { useEffect, useState } from "react";
import { Badge, Button, Card, Notice, PageSection, PageShell, Spinner } from "./components/ui";
import {
  fetchAccountSelf,
  fetchETradeStatus,
  fetchPlatformIdentity,
  markFirstRunComplete,
  saveOnboardingState,
  setupAccount,
  startETradeOAuth,
  type AccountSelfView,
  type ETradeStatusView,
  type PlatformIdentityView,
} from "./firstRunApi";
import { readTenantProvidersState } from "./tenantProviders";
import { firstRunBrokerStep } from "./firstRunBrokerStep";
import { BROKER_CATALOG, brokerCredentialGuidance, isBrokerId } from "../trading/brokerCatalog";
import { listPlans, subscriptionTrial, type PlanView } from "./commercialApi";
import {
  getApprovedFreeQuota,
  isGrantExpired,
  type ApprovedFreeQuotaState,
} from "./approvedFreeQuotaApi";
import { codedMessage } from "../outcomes/outcomeAspects";
import { NotificationPreferencesPanel } from "./NotificationPreferencesPanel";
import { ProfileSection } from "./ProfileSection";
import { fetchProfile, type UserProfileView } from "./profileApi";

export interface FirstRunScreenProps {
  /** Session login, used only as the completion-store key. */
  userLogin: string;
  /** Step to resume at (from the server onboarding state); 1 by default. */
  initialStep?: number;
  /** Called after Finish persists completion. */
  onComplete?: () => void;
  /** Called when the user leaves setup without completing (session-only). */
  onDismiss?: () => void;
  /** Called when the user asks to see subscription plans (checkout tab). */
  onOpenCheckout?: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<Step, string> = {
  1: "Create your account",
  2: "Try a free trial",
  3: "Connect your brokerage",
  4: "Notification preferences",
  5: "Your setup summary",
};

function clampStep(value: number | undefined): Step {
  if (typeof value !== "number" || !Number.isInteger(value)) return 1;
  if (value < 1) return 1;
  if (value > 5) return 5;
  return value as Step;
}

interface TrialStarted {
  planId: string;
  trialEndsAtMs: number;
}

export function FirstRunScreen({ userLogin, initialStep, onComplete, onDismiss, onOpenCheckout }: FirstRunScreenProps) {
  const [step, setStep] = useState<Step>(() => clampStep(initialStep));

  // The gate fetches the saved step asynchronously: adopt a late
  // initialStep (resume) when it arrives. Internal navigation uses
  // goTo and never changes the prop, so this cannot fight the user.
  useEffect(() => {
    setStep(clampStep(initialStep));
  }, [initialStep]);
  const [identity, setIdentity] = useState<PlatformIdentityView | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [setupState, setSetupState] = useState<"idle" | "setting-up" | "done" | "error">("idle");
  // #3309: the setup failure itself, kept so the Notice can render
  // its coded message (catalog businessMessage, or the fixed
  // per-status string) instead of the hardcoded generic copy.
  const [setupError, setSetupError] = useState<Error | null>(null);
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState(false);
  const [trialStarting, setTrialStarting] = useState(false);
  const [trialError, setTrialError] = useState(false);
  const [trialStarted, setTrialStarted] = useState<TrialStarted | null>(null);
  const [etrade, setEtrade] = useState<ETradeStatusView | null>(null);
  const [etradeLoading, setEtradeLoading] = useState(false);
  const [etradeError, setEtradeError] = useState(false);

  /**
   * Issue #3371: step 3 asks the selected broker. A key-pair broker (Alpaca)
   * signs in from its panel in the trading view, so there is no OAuth status to
   * poll and no redirect to offer — asking the user to "Connect E*TRADE" was the
   * one journey still written for a single broker.
   */
  const storedBrokerId = readTenantProvidersState().brokerId;
  // The same branch the hub uses to pick a panel, so an unrecognised id cannot
  // be offered E*TRADE's authorization here while the hub renders Alpaca's panel.
  const knownBrokerId = isBrokerId(storedBrokerId) && storedBrokerId === "etrade" ? "etrade" : "alpaca";
  const brokerStep = firstRunBrokerStep({
    broker: storedBrokerId,
    label: BROKER_CATALOG[knownBrokerId].label,
    credentialKind: brokerCredentialGuidance(knownBrokerId).kind,
  });
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [summary, setSummary] = useState<{
    identity: PlatformIdentityView;
    accountSelf: AccountSelfView;
    etrade: ETradeStatusView | null;
    plans: PlanView[];
    profile: UserProfileView | null;
    // Issue #3263: the approved-free quota for the caller's own
    // account; null when the quota read fails (never blocks the
    // summary — the Billing tab is the authority).
    quota: ApprovedFreeQuotaState | null;
  } | null>(null);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [plansAttempt, setPlansAttempt] = useState(0);
  const [etradeAttempt, setEtradeAttempt] = useState(0);
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await fetchPlatformIdentity();
        if (!cancelled) setIdentity(found);
      } catch {
        if (!cancelled) setIdentityError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1: create the account on entry when none exists. Advances
  // only on a real success; an existing account is never recreated.
  // (setupState is deliberately NOT a dep: setting it inside the
  // effect must not re-run the effect and cancel the in-flight call.)
  useEffect(() => {
    if (loading || identityError || !identity || identity.hasAccount) return;
    let cancelled = false;
    setSetupState("setting-up");
    setSetupError(null);
    (async () => {
      try {
        const result = await setupAccount();
        if (!cancelled) {
          setIdentity(result.identity);
          setSetupError(null);
          setSetupState("done");
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setSetupError(error instanceof Error ? error : new Error("Setup failed"));
          setSetupState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, identityError, identity, setupAttempt]);

  const retrySetup = () => {
    setSetupState("idle");
    setSetupError(null);
    setSetupAttempt((a) => a + 1);
  };

  // Step 2: list plans (trial offers only) when the step is entered.
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setPlansLoading(true);
    setPlansError(false);
    (async () => {
      try {
        const { plans: found } = await listPlans();
        if (!cancelled) setPlans(found);
      } catch {
        if (!cancelled) setPlansError(true);
      } finally {
        if (!cancelled) setPlansLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, plansAttempt]);

  // Step 3: live brokerage status when the step is entered.
  useEffect(() => {
    if (step !== 3) return;
    // Issue #3371: a key-pair broker has no OAuth status to read.
    if (!brokerStep.connectsInWizard) return;
    let cancelled = false;
    setEtradeLoading(true);
    setEtradeError(false);
    (async () => {
      try {
        const status = await fetchETradeStatus();
        if (!cancelled) setEtrade(status);
      } catch {
        if (!cancelled) setEtradeError(true);
      } finally {
        if (!cancelled) setEtradeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, etradeAttempt, brokerStep.connectsInWizard]);

  // Step 5: true summary, re-fetched from the server when entered.
  useEffect(() => {
    if (step !== 5) return;
    let cancelled = false;
    setSummaryLoading(true);
    setSummaryError(false);
    (async () => {
      try {
        const [freshIdentity, accountSelf, liveEtrade, { plans: freshPlans }, liveProfile, quota] =
          await Promise.all([
            fetchPlatformIdentity(),
            fetchAccountSelf(),
            fetchETradeStatus().catch(() => null),
            listPlans().catch(() => ({ plans: [] as PlanView[] })),
            // Profile is ancillary to the summary: a failed read
            // shows as unset, never fails the summary itself.
            fetchProfile().catch(() => null),
            getApprovedFreeQuota().catch(() => null),
          ]);
        if (!cancelled) {
          setSummary({
            identity: freshIdentity,
            accountSelf,
            etrade: liveEtrade,
            plans: freshPlans,
            profile: liveProfile,
            quota,
          });
        }
      } catch {
        if (!cancelled) setSummaryError(true);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, summaryAttempt]);

  const persistStep = (next: Step, extra?: { trialPlanId?: string }) => {
    void saveOnboardingState({ currentStep: next, ...(extra ?? {}) }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("onboarding step could not be persisted", err);
    });
  };

  const goTo = (next: Step, extra?: { trialPlanId?: string }) => {
    persistStep(next, extra);
    setStep(next);
  };

  const startTrial = async (plan: PlanView) => {
    setTrialStarting(true);
    setTrialError(false);
    try {
      const result = await subscriptionTrial({ planId: plan.id });
      setTrialStarted({ planId: plan.id, trialEndsAtMs: result.trialEndsAtMs });
      const fresh = await fetchPlatformIdentity();
      setIdentity(fresh);
      goTo(3, { trialPlanId: plan.id });
    } catch {
      setTrialError(true);
    } finally {
      setTrialStarting(false);
    }
  };

  const connectBrokerage = () => {
    // Persist the step BEFORE navigating away: the OAuth callback
    // returns to the hub, and the gate resumes at this saved step.
    persistStep(3);
    startETradeOAuth();
  };

  const finish = () => {
    void saveOnboardingState({ currentStep: 5, completed: true })
      .catch((err) => {
        // Server completion is best-effort at Finish: the
        // localStorage flag below is the fallback, and the screen
        // must never brick the hub on a state-store failure.
        // eslint-disable-next-line no-console
        console.warn("onboarding completion could not be persisted server-side", err);
      })
      .finally(() => {
        markFirstRunComplete(userLogin);
        onComplete?.();
      });
  };

  const trialPlans = (plans ?? []).filter(
    (p) => typeof p.trialDays === "number" && (p.trialDays as number) > 0,
  );

  return (
    <PageShell
      title="Welcome — first-run setup"
      scopeNote="A guided first run: create your account, try a free trial, connect your brokerage, and set notification preferences."
      loading={loading}
      loadingLabel="Loading your account"
    >
      <PageSection title={`Step ${step} of 5: ${STEP_TITLES[step]}`}>
        {identityError || identity === null ? (
          <Card>
            <Notice tone="danger">
              First-run setup couldn&apos;t load your account. Check your
              connection and try again, or continue to the hub for now —
              setup will show again on your next login until it is completed.
            </Notice>
            {onDismiss && (
              <Button type="button" variant="primary" onClick={onDismiss}>
                Continue to hub
              </Button>
            )}
          </Card>
        ) : step === 1 ? (
          <>
            <Card>
              <p>
                Signed in as: <strong>{identity.userLogin}</strong>
              </p>
            <p>
              Tier: <Badge tone="neutral">{identity.tier}</Badge>
            </p>
            {setupState === "setting-up" ? (
              <Spinner label="Creating your account" />
            ) : setupState === "error" ? (
              <>
                <Notice tone="danger">
                  {setupError?.message ??
                    "Your account could not be created. Check your connection and try again — setup has not advanced."}
                </Notice>
                <Button type="button" variant="primary" onClick={retrySetup}>
                  Try again
                </Button>{" "}
              </>
            ) : (
              <>
                <p>
                  Account: {identity.hasAccount ? "Active" : "Not set up yet"}
                  {identity.tenantId ? ` (workspace ${identity.tenantId})` : ""}
                </p>
                {identity.hasAccount && (
                  <>
                    <p>Credits: ${identity.creditsUSD.toFixed(2)}</p>
                    <p>Included runs remaining: {identity.includedRunsRemaining}</p>
                  </>
                )}
                <p>
                  {identity.hasAccount
                    ? "Your account is ready. Setup continues from here."
                    : "Your account will be created for this login — nothing is charged."}
                </p>
              </>
            )}
            {identity.hasAccount && (
              <Button type="button" variant="primary" onClick={() => goTo(2)}>
                Continue
              </Button>
            )}
            {onDismiss && !identity.hasAccount && setupState !== "setting-up" && (
              <Button type="button" variant="secondary" onClick={onDismiss}>
                Continue to hub
              </Button>
            )}
            </Card>
            <ProfileSection userLogin={userLogin} />
          </>
        ) : step === 2 ? (
          <Card>
            <p>
              Try a plan free before you pay. A trial gives you included
              runs for the trial days shown — no payment is taken. When
              the trial ends, subscribe or pay per run. Starting a trial
              is optional.
            </p>
            {plansLoading ? (
              <Spinner label="Loading plans" />
            ) : plansError ? (
              <Notice tone="danger">
                Plans could not be loaded. You can skip the trial for now
                and come back to it later.
              </Notice>
            ) : trialPlans.length === 0 ? (
              <Notice tone="info">No free trials are available right now.</Notice>
            ) : (
              trialPlans.map((plan) => (
                <div key={plan.id}>
                  <p>
                    <strong>{plan.name}</strong> — Free trial: {plan.trialDays} days,{" "}
                    {plan.includedRuns} included runs. No payment is taken.
                    When the trial ends, subscribe or pay per run. After the
                    trial, ${plan.priceUSD.toFixed(2)} per {plan.periodDays} days.
                  </p>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={trialStarting}
                    loading={trialStarting}
                    onClick={() => void startTrial(plan)}
                  >
                    Start free trial
                  </Button>
                </div>
              ))
            )}
            {trialError && (
              <Notice tone="danger">
                The trial could not be started. Check your connection and try
                again, or skip the trial for now.
              </Notice>
            )}
            <p>
              <Button type="button" variant="secondary" onClick={() => goTo(3)}>
                Skip trial for now
              </Button>{" "}
              {onOpenCheckout && (
                <Button type="button" variant="secondary" onClick={onOpenCheckout}>
                  See subscription plans
                </Button>
              )}{" "}
              <Button type="button" variant="secondary" onClick={() => goTo(1)}>
                Back
              </Button>
            </p>
          </Card>
        ) : step === 3 ? (
          <Card>
            {!brokerStep.connectsInWizard ? (
              <>
                <p>
                  {brokerStep.label} signs in with an API key pair, so there is
                  nothing to authorize here. Sign in from the trading view: the{" "}
                  {brokerStep.label} panel asks for your key id and secret, verifies
                  them against {brokerStep.label}, and never shows the secret again.
                </p>
                <Button type="button" variant="primary" onClick={() => goTo(4)}>
                  Continue
                </Button>{" "}
              </>
            ) : etradeLoading ? (
              <Spinner label="Checking brokerage status" />
            ) : etradeError || etrade === null ? (
              <>
                <Notice tone="danger">
                  Brokerage status could not be loaded. You can connect later
                  from the trading view, or continue without connecting.
                </Notice>
                <Button type="button" variant="primary" onClick={() => goTo(4)}>
                  Continue without connecting
                </Button>{" "}
              </>
            ) : etrade.authenticated ? (
              <>
                <p>
                  Brokerage status: Connected
                  {etrade.environment ? ` (${etrade.environment})` : ""}. Your
                  E*TRADE account is connected.
                </p>
                <Button type="button" variant="primary" onClick={() => goTo(4)}>
                  Continue
                </Button>{" "}
              </>
            ) : (
              <>
                <p>
                  Brokerage status: Not connected. Connect E*TRADE to trade
                  from the hub, or continue without connecting — you can
                  connect later from the trading view.
                </p>
                <Button type="button" variant="primary" onClick={connectBrokerage}>
                  Connect E*TRADE
                </Button>{" "}
                <Button type="button" variant="secondary" onClick={() => goTo(4)}>
                  Continue without connecting
                </Button>{" "}
              </>
            )}
            <Button type="button" variant="secondary" onClick={() => goTo(2)}>
              Back
            </Button>
          </Card>
        ) : step === 4 ? (
          <>
            <NotificationPreferencesPanel
              identity={identity}
              onSaved={() => {
                setPrefsSaved(true);
                goTo(5);
              }}
              onContinue={() => goTo(5)}
            />
            <Button type="button" variant="secondary" onClick={() => goTo(3)}>
              Back
            </Button>
          </>
        ) : (
          <Card>
            {summaryLoading ? (
              <Spinner label="Loading your setup summary" />
            ) : summaryError || summary === null ? (
              <>
                <Notice tone="danger">
                  Your setup summary could not be loaded. Your account, trial,
                  and preferences are still as you left them — try again to
                  see the summary.
                </Notice>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setSummary(null);
                    setSummaryAttempt((a) => a + 1);
                  }}
                >
                  Try again
                </Button>{" "}
                <Button type="button" variant="primary" onClick={finish}>
                  Finish
                </Button>
              </>
            ) : (
              <>
                <p>
                  Signed in as: <strong>{summary.identity.userLogin}</strong>
                </p>
                <p>
                  Account: Active
                  {summary.identity.tenantId ? ` (workspace ${summary.identity.tenantId})` : ""}
                </p>
                <p>
                  Tier: <Badge tone="neutral">{summary.identity.tier}</Badge>
                </p>
                <p>Credits: ${summary.identity.creditsUSD.toFixed(2)}</p>
                <p>Included runs remaining: {summary.identity.includedRunsRemaining}</p>
                <p>
                  Display name: {summary.profile?.displayName ?? summary.identity.userLogin}
                </p>
                <p>Phone: {summary.profile?.phone ?? "Not provided"}</p>
                {/* Issue #3263: approved-free quota at a glance. The
                    grant is operator-set; a missing quota read or an
                    inactive grant reads as no grant, never as zero —
                    except an EXPIRED grant, which renders the
                    catalog-coded expired message. */}
                {summary.quota === null || !summary.quota.grant.active ? (
                  summary.quota !== null && isGrantExpired(summary.quota.grant) ? (
                    <p>{codedMessage("FAILURE_APPROVED_FREE_QUOTA_EXPIRED")}</p>
                  ) : (
                    <p>Approved-free grant: No approved-free grant.</p>
                  )
                ) : (
                  <p>
                    Approved-free runs remaining:{" "}
                    {summary.quota.families
                      .map(
                        (row) =>
                          `${row.family} ${row.remaining === null ? "—" : row.remaining}`,
                      )
                      .join(", ")}
                    {summary.quota.settings
                      ? ` (${summary.quota.settings.windowKind === "week" ? "per week" : "per month"})`
                      : ""}
                    .
                  </p>
                )}
                {(() => {
                  const trialRow = summary.accountSelf.subscriptions
                    .filter((s) => s.provider === "trial")
                    .sort((a, b) => b.periodEndMs - a.periodEndMs)[0];
                  const trialPlanId = trialRow?.planId ?? trialStarted?.planId ?? null;
                  const trialEndsAtMs = trialRow?.periodEndMs ?? trialStarted?.trialEndsAtMs ?? null;
                  if (!trialPlanId) {
                    return <p>Free trial: No trial started.</p>;
                  }
                  const plan = summary.plans.find((p) => p.id === trialPlanId);
                  const planName = plan?.name ?? trialPlanId;
                  const ended =
                    trialEndsAtMs !== null && trialEndsAtMs <= Date.now();
                  return (
                    <p>
                      Free trial: {planName} —{" "}
                      {ended
                        ? `ended ${new Date(trialEndsAtMs as number).toLocaleDateString()}`
                        : `ends ${new Date(trialEndsAtMs as number).toLocaleDateString()}`}
                      {plan ? `, ${plan.includedRuns} included runs` : ""}.
                    </p>
                  );
                })()}
                <p>
                  Brokerage:{" "}
                  {summary.etrade === null
                    ? "status unavailable — check the trading view"
                    : summary.etrade.authenticated
                      ? `Connected${summary.etrade.environment ? ` (${summary.etrade.environment})` : ""}`
                      : "Not connected"}
                </p>
                <p>
                  Notification preferences:{" "}
                  {prefsSaved
                    ? "Preferences saved."
                    : "Not saved during this setup — you can change them later in Settings."}
                </p>
                <p>
                  {onOpenCheckout && (
                    <Button type="button" variant="secondary" onClick={onOpenCheckout}>
                      Sign up for a subscription
                    </Button>
                  )}{" "}
                  <Button type="button" variant="secondary" onClick={() => goTo(4)}>
                    Back
                  </Button>{" "}
                  <Button type="button" variant="primary" onClick={finish}>
                    Finish
                  </Button>
                </p>
              </>
            )}
          </Card>
        )}
      </PageSection>
    </PageShell>
  );
}
