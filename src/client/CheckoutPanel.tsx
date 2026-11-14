/**
 * Issue #2137: user-facing checkout UI — pay for a run, or buy, view,
 * and cancel a subscription. Issue #3262 adds a Top up tab: add money
 * to the account (credits fund pay-per-run screens), crediting only
 * on verified payment through the native checkout pattern.
 *
 * Identity rule: the session cookie is the identity. This panel never
 * sends an identity header and never reads tier or tenant from a
 * header or localStorage claim. Since #2219 (program #2218 slice 1)
 * tenant / user / account are AUTOMATIC and READ-ONLY here: the
 * panel fetches the resolved identity from the server's self-only
 * identity endpoint and only displays it — there is no tenant
 * input anywhere in this panel, in either tab. The server derives
 * the run/checkout tenant from that resolved identity and ignores
 * any client-supplied tenantId, even on mismatch. While identity
 * is loading the panel shows a neutral loading state, never an
 * input; on resolution failure it shows the failure message,
 * never an input fallback. The userLogin prop is display-only;
 * the subscription query target names the session user for the
 * routes' self-or-operator contract, and the server enforces
 * that contract against the session — a mismatched target is refused
 * server-side, not trusted from here.
 *
 * Charging rule: this panel never decides whether a charge happens.
 * The server gate does. When the monetization flag is OFF the panel
 * says runs are free and never presents a charge. Prices come from
 * the server pricing route (PROPOSED until owner approval), never
 * from client constants. The network marker and the browser payment
 * scope come from the same route, never from client constants: the
 * panel renders the server-derived marker (testnet presentation
 * while no rail accepts mainnet) and offers card only in the browser
 * by default. A payment URL is shown only when the server provides
 * the native Stripe checkoutUrl in the check-payment response;
 * x402 has no URL, so the panel presents the 402 challenge flow
 * (network, amount, recipient) instead of inventing a link.
 * Renewal is repurchase before expiry — subscriptions do not
 * auto-renew, and the copy says so.
 *
 * Dependency: the subscription endpoints are on main (PR #2142,
 * merged). If the deployed backend does not serve them yet, those
 * calls 404 and the subscription section degrades to a
 * not-deployed notice instead of an error.
 */
import React from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Modal,
  Notice,
  PageShell,
  Select,
  Spinner,
  Table,
  TabPanel,
  Tabs,
  TextInput,
} from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { startPolling } from "./polling";
import { codedMessage } from "../outcomes/outcomeAspects";
import { AmbientOfferCompare, type PlanChoice } from "./PlanCompare";
import { UpgradeOffer } from "./UpgradeOffer";
import {
  buildGoalCommand,
  buildNonGoalCommand,
  checkPayment,
  CommercialApiError,
  formatPeriodEnd,
  formatUSD,
  getFeatures,
  getIdentity,
  getPricing,
  getSubmissionStatus,
  getSubscriptionStatus,
  isOfferTrigger,
  listPlans,
  packCheckout,
  packConfirm,
  parseSymbols,
  submitRun,
  subscriptionCancel,
  subscriptionCheckout,
  subscriptionPurchase,
  topUpCheckout,
  topUpConfirm,
  type ChallengeFlow,
  type CommercialAccountView,
  type OfferContext,
  type OfferTrigger,
  type PackCheckoutView,
  type PlatformIdentityView,
  type PlanView,
  type Pricing,
  type RunsPackOfferView,
  type ScreenerFamily,
  type SubmitResult,
  type SubscriptionStatusView,
  type SubscriptionView,
  type TopUpCheckoutView,
} from "./commercialApi";

const GOAL_KINDS = [
  "income",
  "directional",
  "volatility_event",
  "hedge_protect",
  "repair",
  "deconcentrate",
  "iv_harvest",
  "capital_efficient_leverage",
  "cash_secured_entry",
] as const;

const DIRECTIONS = ["bullish", "bearish", "range_bound", "volatile", "unknown"] as const;

function errText(err: unknown): string {
  if (err instanceof CommercialApiError) return err.message;
  return "Something went wrong. Try again later.";
}

/**
 * Issue #2669 (2.14): which rail manages a subscription row. A row
 * carrying a provider subscription id is Billing-managed — the cancel
 * route provider-cancels it first (Stripe stops charging). A row
 * without one is a native repurchase row, canceled locally.
 */
function managedByLabel(row: SubscriptionView): string {
  return row.providerSubscriptionId ? "Billing (Stripe)" : "Native";
}

function newJobId(): string {
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Issue #3246 — preselection from an offer deep link
 * (`?plan=<versionId>&offer=<trigger>`): the plan param matches
 * ONLY a fetched effective plan. A superseded or unknown id is
 * ignored — the panel never mints, highlights, or audits a plan
 * it did not fetch. The offer param must be a known trigger.
 */
export function matchPreselectedPlan(plans: PlanView[], planParam: string | null): PlanView | null {
  if (!planParam) return null;
  return plans.find((p) => p.id === planParam) ?? null;
}

export function parseOfferTriggerParam(value: string | null): OfferTrigger | null {
  return value !== null && isOfferTrigger(value) ? value : null;
}

export function CheckoutPanel({ userLogin }: { userLogin: string }) {
  // Deep links (#2776): the checkout tabs live in `?checkoutTab=` via
  // the shared hook (aliased to the old tab/setTab names, so the panel
  // below is untouched).
  const { activeTab: tab, handleTabChange: setTab } = useUrlSyncedTabs<
    "pay" | "subscriptions" | "topup"
  >({
    param: "checkoutTab",
    isValid: (v): v is "pay" | "subscriptions" | "topup" =>
      v === "pay" || v === "subscriptions" || v === "topup",
    defaultTab: "pay",
  });
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pricing, setPricing] = React.useState<Pricing | null>(null);
  const [flagOn, setFlagOn] = React.useState<boolean | null>(null);
  const [identity, setIdentity] = React.useState<PlatformIdentityView | null>(null);
  const [identityError, setIdentityError] = React.useState<string | null>(null);
  const [subStatus, setSubStatus] = React.useState<SubscriptionStatusView | null>(null);
  const [plans, setPlans] = React.useState<PlanView[] | null>(null);
  const [subsDeployed, setSubsDeployed] = React.useState(true);

  // Pay form
  const [family, setFamily] = React.useState<ScreenerFamily>("stock");
  const [symbols, setSymbols] = React.useState("");
  const [goalKind, setGoalKind] = React.useState<string>("income");
  const [direction, setDirection] = React.useState<string>("bullish");
  const [email, setEmail] = React.useState("");
  const [authorized, setAuthorized] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitResult, setSubmitResult] = React.useState<SubmitResult | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [runStatus, setRunStatus] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<string | null>(null);
  const [checkPaymentUrl, setCheckPaymentUrl] = React.useState<string | null>(null);
  const [checkChallenge, setCheckChallenge] = React.useState<ChallengeFlow | null>(null);
  const [checking, setChecking] = React.useState(false);

  // Subscription buy form
  const [buyPlan, setBuyPlan] = React.useState<PlanView | null>(null);
  const [buyCheckoutId, setBuyCheckoutId] = React.useState<string | null>(null);
  const [buyCheckoutUrl, setBuyCheckoutUrl] = React.useState<string | null>(null);
  // #2198: the native purchase route retrieves the Stripe session by id, so the panel carries the
  // session id the checkout route returned alongside the draft id (compatibility carry-through only
  // — the slice-3 UI rework owns presenting the checkoutUrl / 402 flow).
  const [buySessionId, setBuySessionId] = React.useState<string | null>(null);
  const [buying, setBuying] = React.useState(false);
  const [buyError, setBuyError] = React.useState<string | null>(null);
  const [buyDone, setBuyDone] = React.useState<string | null>(null);
  const [canceling, setCanceling] = React.useState(false);
  const [cancelDone, setCancelDone] = React.useState<string | null>(null);
  const [cancelDetail, setCancelDetail] = React.useState<string | null>(null);
  // Issue #2669 (2.14): cancel is a confirmed action — the dialog lists
  // what will be canceled and nothing is posted until confirmed.
  const [cancelConfirmOpen, setCancelConfirmOpen] = React.useState(false);

  // Rows the cancel route would cancel: active, uncanceled, unexpired.
  // The server decides the same set from the session identity; this is
  // display only — the client never selects rows to cancel.
  const cancelableSubs = (subStatus?.subscriptions ?? []).filter(
    (s) => s.status === "active" && !s.canceledAtMs && s.periodEndMs > Date.now(),
  );

  // Top-up form (#3262): add money, crediting only on verified payment.
  const [topUpAmount, setTopUpAmount] = React.useState("");
  const [topUpRail, setTopUpRail] = React.useState<"card" | "x402">("card");
  const [topUpMint, setTopUpMint] = React.useState<TopUpCheckoutView | null>(null);
  const [topUpMinting, setTopUpMinting] = React.useState(false);
  const [topUpConfirming, setTopUpConfirming] = React.useState(false);
  const [topUpError, setTopUpError] = React.useState<string | null>(null);
  const [topUpDone, setTopUpDone] = React.useState<string | null>(null);
  const [topUpProof, setTopUpProof] = React.useState("");

  // Issue #3246 — offer preselection and acceptance context. The
  // offer context is audit-only: it is included in the NEXT mint
  // call only (subscription checkout or top-up mint) and cleared
  // after that mint — a re-mint is not from the offer. It never
  // changes a price, a plan, or an authorization. The preselected
  // plan is a marker on a fetched plan row only — never an
  // auto-mint, never a preselected purchase.
  const [offerContext, setOfferContext] = React.useState<OfferContext | null>(null);
  const [preselectedPlanId, setPreselectedPlanId] = React.useState<string | null>(null);
  const offerParamsApplied = React.useRef(false);
  // Issue #3246 slice 3 — runs-pack purchase from the ambient
  // compare: the pack is a picked marker only (never an
  // auto-mint); the mint/confirm pair mirrors the top-up tab.
  const [preselectedPackVersionId, setPreselectedPackVersionId] = React.useState<string | null>(null);
  const [pendingPack, setPendingPack] = React.useState<{ pack: RunsPackOfferView; shownAtMs: number } | null>(null);
  const [packRail, setPackRail] = React.useState<"card" | "x402">("card");
  const [packMint, setPackMint] = React.useState<PackCheckoutView | null>(null);
  const [packMinting, setPackMinting] = React.useState(false);
  const [packConfirming, setPackConfirming] = React.useState(false);
  const [packError, setPackError] = React.useState<string | null>(null);
  const [packDone, setPackDone] = React.useState<string | null>(null);
  const [packProof, setPackProof] = React.useState("");
  // Quota-exhausted offer (design §5.4): set when the pay-tab
  // poller sees the quota_exhausted outcome, with the family the
  // run was submitted under.
  const [quotaOffer, setQuotaOffer] = React.useState(false);
  const [quotaOfferFamily, setQuotaOfferFamily] = React.useState<ScreenerFamily | null>(null);

  // Top-up field errors (#3574): client-side validation errors are
  // field-associated (TextInput `error` → aria-invalid + aria-describedby
  // to the field error span, ux-architecture §13). The form-level
  // `topUpError` Notice stays for server failures, which no field owns.
  const [topUpAmountError, setTopUpAmountError] = React.useState<string | null>(null);
  const [topUpEmailError, setTopUpEmailError] = React.useState<string | null>(null);
  const [topUpProofError, setTopUpProofError] = React.useState<string | null>(null);
  const topUpAmountRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const topUpEmailRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const topUpProofRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Focus target for the first invalid field (#3574). Set alongside the
  // field error; the effect below focuses after render, so the
  // aria-describedby error is in the DOM when the screen reader lands on
  // the field. Focus moves only on the user's own submit (a validation
  // failure), never on an agent-produced message.
  const [topUpErrorFocus, setTopUpErrorFocus] = React.useState<"amount" | "email" | "proof" | null>(null);
  React.useEffect(() => {
    if (!topUpErrorFocus) return;
    const target =
      topUpErrorFocus === "amount"
        ? topUpAmountRef.current
        : topUpErrorFocus === "email"
          ? topUpEmailRef.current
          : topUpProofRef.current;
    target?.focus();
    setTopUpErrorFocus(null);
  }, [topUpErrorFocus]);

  const refreshSubscription = React.useCallback(async () => {
    try {
      const [status, planList] = await Promise.all([getSubscriptionStatus(userLogin), listPlans()]);
      setSubStatus(status);
      setPlans(planList.plans);
      setSubsDeployed(true);
    } catch (err) {
      if (err instanceof CommercialApiError && err.status === 404) {
        setSubsDeployed(false);
      }
    }
  }, [userLogin]);

  // Issue #3246 — apply the offer deep-link params once, when the
  // fetched plans first arrive. Unknown or superseded plan ids
  // and unknown triggers are ignored silently. The pack param is
  // a marker only: it matches a pack row in the compare (badge),
  // and an unknown pack id simply never matches — never a mint.
  React.useEffect(() => {
    if (offerParamsApplied.current || !plans) return;
    offerParamsApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const matched = matchPreselectedPlan(plans, params.get("plan"));
    if (matched) setPreselectedPlanId(matched.id);
    const packParam = params.get("pack");
    if (packParam) setPreselectedPackVersionId(packParam);
    const trigger = parseOfferTriggerParam(params.get("offer"));
    if (trigger) setOfferContext({ trigger });
  }, [plans]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pricingRes, featuresRes] = await Promise.all([
          getPricing(),
          getFeatures().catch(() => null),
        ]);
        if (cancelled) return;
        setPricing(pricingRes);
        const flagFeatures = featuresRes?.features ?? null;
        setFlagOn(flagFeatures ? flagFeatures["monetization"] === true : pricingRes.monetizationEnabled);
        // Read-only identity: a resolution failure sets the error
        // display — never an input fallback.
        try {
          setIdentity(await getIdentity());
        } catch (err) {
          if (!cancelled) setIdentityError(errText(err));
        }
      } catch (err) {
        if (!cancelled) setLoadError(errText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
      await refreshSubscription();
    })();
    return () => {
      cancelled = true;
    };
  }, [userLogin, refreshSubscription]);

  // Poll the workflow status while a paid run is in flight.
  // Issue #2376 slice 1: the hand-rolled 5s chain rides the shared
  // polling contract (startPolling) — same 5s cadence, same
  // immediate first read, same 60-poll cap, same stop on a
  // transient read failure (the user can still use the verify
  // button and re-read status manually). Effect cleanup stops
  // the poller; the cap/failure paths stop it directly.
  React.useEffect(() => {
    if (!submitResult?.workflowId || submitResult.status === "redeemed_started" || !polling) return;
    let stopped = false;
    let polls = 0;
    let stop: () => void = () => {};
    const tick = async () => {
      if (stopped || polls >= 60) {
        setPolling(false);
        stop();
        return;
      }
      polls += 1;
      try {
        const res = await getSubmissionStatus(submitResult.workflowId!);
        if (stopped) return;
        // Issue #3263: a quota-exhausted completion carries the
        // outcome + catalog code — render the catalog message,
        // never the raw outcome string or a bare "complete". A
        // quota-covered start carries the success code the same
        // way (SUCCESS_APPROVED_FREE_QUOTA_COVERED) — render its
        // catalog message too, never a bare "started".
        if (res.outcome === "quota_exhausted") {
          setRunStatus(
            codedMessage(res.outcomeCode ?? "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED"),
          );
          // Issue #3246: the quota-exhausted outcome surfaces the
          // upgrade offer in the pay tab, for the family the run
          // was submitted under.
          setQuotaOffer(true);
          setQuotaOfferFamily(family);
        } else if (res.outcomeCode === "SUCCESS_APPROVED_FREE_QUOTA_COVERED") {
          setRunStatus(codedMessage(res.outcomeCode));
        } else {
          setRunStatus(res.status);
        }
      } catch {
        // A transient status-read failure stops polling; the user can
        // still use the verify button and re-read status manually.
        if (!stopped) setPolling(false);
        stop();
      }
    };
    stop = startPolling(tick, { fastMs: 5_000, idleMs: 5_000, immediate: true });
    return () => {
      stopped = true;
      stop();
    };
  }, [submitResult, polling]);

  const priceFor = (f: ScreenerFamily): string =>
    pricing ? formatUSD(pricing.prices[f]) : "unavailable";

  const handlePay = async () => {
    setSubmitError(null);
    setSubmitResult(null);
    setRunStatus(null);
    setCheckResult(null);
    setQuotaOffer(false);
    setQuotaOfferFamily(null);
    if (!email.trim()) {
      setSubmitError("Enter the checkout contact email.");
      return;
    }
    // No tenant validation here: tenant comes from the resolved
    // server identity (#2219), never from this panel.
    if (pricing?.monetizationEnabled && !authorized) {
      setSubmitError("Authorize the charge at submission to continue.");
      return;
    }
    const jobId = newJobId();
    let screenerCommand: Record<string, unknown>;
    try {
      if (family === "goal") {
        const res = await buildGoalCommand({
          jobId,
          goalKind,
          direction,
          symbols: parseSymbols(symbols),
        });
        screenerCommand = res.screenerCommand;
      } else {
        const list = parseSymbols(symbols);
        if (list.length === 0) {
          setSubmitError("Enter at least one symbol — runs are bounded to the symbols you choose.");
          return;
        }
        screenerCommand = buildNonGoalCommand(jobId, family, list);
      }
    } catch (err) {
      setSubmitError(errText(err));
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitRun({
        family,
        email: email.trim(),
        trigger: "manual",
        scheduleKind: "one_off",
        authorizedAtSubmission: pricing?.monetizationEnabled ? true : undefined,
        screenerCommand,
      });
      setSubmitResult(res);
      if (res.status === "payment_started") setPolling(true);
    } catch (err) {
      setSubmitError(errText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckPayment = async () => {
    if (!submitResult) return;
    setChecking(true);
    setCheckResult(null);
    setCheckPaymentUrl(null);
    setCheckChallenge(null);
    try {
      const res = await checkPayment(submitResult.runRequestId);
      setCheckPaymentUrl(res.paymentUrl ?? null);
      setCheckChallenge(res.challengeFlow ?? null);
      if (res.paid && res.delivered) {
        setCheckResult("Payment verified — the run is starting. Keep watching its status below.");
      } else if (res.paid && !res.delivered) {
        setCheckResult("Payment verified, but the run could not be woken yet. Tap this again to retry.");
      } else {
        setCheckResult(
          `Not paid yet (checkout state: ${res.state ?? "unknown"}).${
            res.paymentUrl ? " Use the payment link below, then check again." : " Complete the payment for this request, then check again."
          }`
        );
      }
    } catch (err) {
      setCheckResult(errText(err));
    } finally {
      setChecking(false);
    }
  };

  // Issue #3246 — the ambient compare's actions. Choosing a plan
  // marks the matching fetched plan row and records the offer
  // context for the next mint; a version that matches no fetched
  // plan (superseded between fetches) is ignored, never
  // highlighted. Buying credits moves to the top-up tab with the
  // offer context attached to the next mint.
  const handleCompareChoose = (choice: PlanChoice, shownAtMs: number) => {
    if (!plans) return;
    const matched = matchPreselectedPlan(plans, choice.versionId);
    if (!matched) return;
    setPreselectedPlanId(matched.id);
    setOfferContext({ trigger: "ambient", shownAtMs });
  };

  const handleCompareBuyCredits = () => {
    setOfferContext({ trigger: "ambient" });
    setTab("topup");
  };

  // Issue #3246 slice 3 — the ambient compare's pack action.
  // Buying a pack picks the pack and records the offer context
  // for the next mint; the mint happens only from the Create pack
  // checkout button in the subscriptions tab below — never here,
  // never on arrival.
  const handleCompareBuyPack = (pack: RunsPackOfferView, shownAtMs: number) => {
    setPendingPack({ pack, shownAtMs });
    setPreselectedPackVersionId(pack.versionId);
    setOfferContext({ trigger: "ambient", shownAtMs });
  };

  const handlePackMint = async () => {
    if (!pendingPack) return;
    setPackError(null);
    setPackDone(null);
    setPackMint(null);
    if (!email.trim()) {
      setPackError("Enter the checkout contact email.");
      return;
    }
    setPackMinting(true);
    try {
      // Issue #3246: the offer context rides the mint call only
      // when the pack was picked from an offer, and is cleared
      // after the mint — a re-mint is not from the offer.
      const context = offerContext ?? undefined;
      const res = await packCheckout({
        versionId: pendingPack.pack.versionId,
        rail: packRail,
        email: email.trim(),
        ...(context ? { offerContext: context } : {}),
      });
      setOfferContext(null);
      setPendingPack(null);
      setPackMint(res);
    } catch (err) {
      setPackError(errText(err));
    } finally {
      setPackMinting(false);
    }
  };

  const handlePackConfirm = async () => {
    if (!packMint) return;
    if (packMint.rail === "x402" && !packProof.trim()) {
      setPackError("Paste the payment proof from your wallet or agent, then verify.");
      return;
    }
    setPackConfirming(true);
    setPackError(null);
    try {
      const res = await packConfirm({
        packRequestId: packMint.packRequestId,
        ...(packMint.rail === "card"
          ? { checkoutSessionId: packMint.checkoutSessionId ?? undefined }
          : { paymentProof: packProof.trim() }),
      });
      setPackDone(
        `Runs pack credited: ${res.creditedRuns} runs. New pack balance: ${res.packRunsRemaining} runs.`
      );
      setPackMint(null);
      setPackProof("");
      // Refresh the read-only identity display so the header
      // credits match; the confirm response is the authority, this
      // is display-only.
      try {
        setIdentity(await getIdentity());
      } catch {
        // Identity refresh failure leaves the confirmed balance shown above.
      }
    } catch (err) {
      setPackError(errText(err));
    } finally {
      setPackConfirming(false);
    }
  };

  const handleBuyCheckout = async (plan: PlanView) => {
    setBuyError(null);
    setBuyDone(null);
    setBuyCheckoutId(null);
    setBuyCheckoutUrl(null);
    setBuySessionId(null);
    if (!email.trim()) {
      setBuyError("Enter the checkout contact email.");
      return;
    }
    // No tenant validation here: tenant comes from the resolved
    // server identity (#2219), never from this panel.
    setBuying(true);
    try {
      // Issue #3246: the offer context rides the mint call only
      // when the purchase was started from an offer, and is
      // cleared after the mint — a re-mint is not from the offer.
      const context = offerContext ?? undefined;
      const res = await subscriptionCheckout({
        planId: plan.id,
        email: email.trim(),
        ...(context ? { offerContext: context } : {}),
      });
      setOfferContext(null);
      setPreselectedPlanId(null);
      setBuyPlan(plan);
      setBuyCheckoutId(res.checkoutRequestId);
      // The native subscription checkout always returns a URL (slice
      // 2); the legacy cfpay checkout carried none. Present the link
      // only when the server provides one — never invent one.
      setBuyCheckoutUrl(typeof res.checkoutUrl === "string" ? res.checkoutUrl : null);
      setBuySessionId(res.checkoutSessionId);
    } catch (err) {
      setBuyError(errText(err));
    } finally {
      setBuying(false);
    }
  };

  const handleBuyPurchase = async () => {
    if (!buyPlan || !buyCheckoutId || !buySessionId) return;
    setBuying(true);
    setBuyError(null);
    try {
      const res = await subscriptionPurchase({
        planId: buyPlan.id,
        checkoutRequestId: buyCheckoutId,
        checkoutSessionId: buySessionId,
      });
      setBuyDone(
        `Subscription active through ${formatPeriodEnd(res.subscription.periodEndMs)}. Effective tier: ${res.effectiveTier}.`
      );
      setBuyCheckoutId(null);
      setBuyCheckoutUrl(null);
      setBuySessionId(null);
      await refreshSubscription();
    } catch (err) {
      setBuyError(errText(err));
    } finally {
      setBuying(false);
    }
  };

  const handleCancel = async () => {
    setCancelConfirmOpen(false);
    setCanceling(true);
    setCancelDone(null);
    setCancelDetail(null);
    setBuyError(null);
    try {
      // Issue #1069 §8: the request carries no identifiers — no userId,
      // no tenantId. The server resolves (user, tenant) from the session
      // identity, so the cancel cannot be steered at another tenant.
      // Issue #3523: the success message is the response's catalog businessMessage
      // (verbatim from the outcome catalog via the route); the detail line names what
      // was cancelled and the access-through date, so the UI explains what was cancelled
      // vs what remains (the refreshed table below shows the remaining rows). A replay
      // now rejects 409 with the coded none-active message (rendered via errText).
      const res = await subscriptionCancel();
      setCancelDone(res.message);
      const plans = [...new Set(res.canceled.map((r) => r.planId))].join(", ");
      // Issue #2781: name the bundle purchases canceled with the
      // subscription, and say plainly when a bundle cancel failed
      // (the subscription cancel still stands).
      const canceledBundleCount = (res.canceledBundles ?? []).length;
      const bundleNote =
        canceledBundleCount > 0
          ? ` Bundle purchases canceled: ${canceledBundleCount}.`
          : res.bundleCancelFailed
            ? " A bundle cancel failed — the subscription cancel still stands; an operator can retry the bundle cancel."
            : "";
      setCancelDetail(
        res.downgradeTiming === "immediate"
          ? `Canceled: ${plans} — access ended now.${bundleNote}`
          : res.accessThroughMs
            ? `Canceled: ${plans} — access through ${formatPeriodEnd(res.accessThroughMs)}.${bundleNote}`
            : `Canceled: ${plans}.${bundleNote}`,
      );
    } catch (err) {
      setBuyError(errText(err));
    } finally {
      // Issue #3523: refresh on every path (including failures) so what remains is always
      // the verified server state — a partial cancel shows its remaining rows, never a claim.
      await refreshSubscription();
      setCanceling(false);
    }
  };

  // #3262: x402 is offered only when the browser scope allows it AND
  // the pricing network carries an x402 network; card is always offered.
  const topUpX402Offered =
    pricing?.browserPaymentScope === "card-and-x402" && pricing.network.x402Network !== null;

  const handleTopUpMint = async () => {
    setTopUpError(null);
    setTopUpAmountError(null);
    setTopUpEmailError(null);
    setTopUpProofError(null);
    setTopUpDone(null);
    setTopUpMint(null);
    if (!email.trim()) {
      setTopUpEmailError("Enter the checkout contact email.");
      setTopUpErrorFocus("email");
      return;
    }
    const amount = Number(topUpAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setTopUpAmountError("Enter an amount greater than zero.");
      setTopUpErrorFocus("amount");
      return;
    }
    const limits = pricing?.topUpLimits ?? null;
    if (limits && (amount < limits.minUSD || amount > limits.maxUSD)) {
      setTopUpAmountError(`Amount must be between ${formatUSD(limits.minUSD)} and ${formatUSD(limits.maxUSD)}.`);
      setTopUpErrorFocus("amount");
      return;
    }
    setTopUpMinting(true);
    try {
      // Issue #3246: the offer context rides the mint call only
      // when the top-up was started from an offer, and is cleared
      // after the mint — a re-mint is not from the offer.
      const context = offerContext ?? undefined;
      const res = await topUpCheckout({
        amountUSD: amount,
        rail: topUpRail,
        email: email.trim(),
        ...(context ? { offerContext: context } : {}),
      });
      setOfferContext(null);
      setTopUpMint(res);
    } catch (err) {
      setTopUpError(errText(err));
    } finally {
      setTopUpMinting(false);
    }
  };

  const handleTopUpConfirm = async () => {
    if (!topUpMint) return;
    if (topUpMint.rail === "x402" && !topUpProof.trim()) {
      setTopUpProofError("Paste the payment proof from your wallet or agent, then verify.");
      setTopUpErrorFocus("proof");
      return;
    }
    setTopUpConfirming(true);
    setTopUpError(null);
    setTopUpProofError(null);
    try {
      const res = await topUpConfirm({
        topUpRequestId: topUpMint.topUpRequestId,
        ...(topUpMint.rail === "card"
          ? { checkoutSessionId: topUpMint.checkoutSessionId ?? undefined }
          : { paymentProof: topUpProof.trim() }),
      });
      // Issue #3571: the confirm success renders the catalog message
      // for the outcome the 200 already proves — never a hand-written
      // sentence. Amounts stay as data after the message, not message
      // text. The guarded fallback covers a legacy body without a code.
      setTopUpDone(
        `Top-up credited: ${formatUSD(res.creditedUSD)}. New credit balance: ${formatUSD(res.account.creditsUSD ?? 0)}.`
      );
      setTopUpMint(null);
      setTopUpProof("");
      // Refresh the read-only identity display so the header credits
      // match; the confirm response is the authority, this is display-only.
      try {
        setIdentity(await getIdentity());
      } catch {
        // Identity refresh failure leaves the confirmed balance shown above.
      }
    } catch (err) {
      setTopUpError(errText(err));
    } finally {
      setTopUpConfirming(false);
    }
  };

  return (
    <PageShell
      title="Checkout"
      scopeNote={
        pricing?.network.acceptsMainnet
          ? "Pay for a screener run or manage a subscription. Prices shown are proposed until owner approval."
          : "Pay for a screener run or manage a subscription. Test-network build: no mainnet payment is accepted. Prices shown are proposed until owner approval."
      }
      loading={loading}
      error={loadError}
    >
      <Tabs
        tabs={[
          { id: "pay", label: "Pay per run" },
          { id: "subscriptions", label: "Subscriptions" },
          { id: "topup", label: "Top up" },
        ]}
        value={tab}
        onChange={setTab}
        idBase="checkout-tabs"
        ariaLabel="Checkout sections"
      />
      {/* #2219: read-only identity display, shared by all tabs.
          Never an input: loading shows a neutral loading line,
          and a resolution failure shows the failure message. */}
      {identityError ? (
        <Notice tone="danger">{identityError}</Notice>
      ) : identity ? (
        <p>
          Signed in as <strong>{identity.userLogin}</strong> — tenant{" "}
          <strong>{identity.tenantId ?? "No account on file"}</strong> — account tier{" "}
          <strong>{identity.tier}</strong> — credits {formatUSD(identity.creditsUSD)} — included runs{" "}
          {identity.includedRunsRemaining}.
          {!identity.hasAccount && " No account is on file for this login."}
        </p>
      ) : (
        <p>Loading account identity…</p>
      )}
      {tab === "pay" && (
        <Card>
          {flagOn === false && (
            <Notice tone="info">
              Payments are currently off — runs submitted here are free. The server gate decides; no charge is
              presented while the flag is off.
            </Notice>
          )}
          {pricing?.monetizationEnabled && (
            <Notice tone="warning">
              Test-network build — no mainnet payment is accepted. One charge per run-request: shards, stages,
              retries, and re-serves are free.
            </Notice>
          )}
          <Select label="Screen family" value={family} onChange={(e) => setFamily(e.target.value as ScreenerFamily)}>
            <option value="stock">Stock</option>
            <option value="goal">Goal</option>
            <option value="options">Options</option>
            <option value="strategy">Strategy</option>
          </Select>
          {family === "goal" ? (
            <>
              <Select label="Goal kind" value={goalKind} onChange={(e) => setGoalKind(e.target.value)}>
                {GOAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
              <Select label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
              <TextInput
                label="Symbols (optional, comma-separated)"
                hint="Leave empty to screen the scenario universe."
                value={symbols}
                onChange={(e) => setSymbols(e.target.value)}
              />
            </>
          ) : (
            <TextInput
              label="Symbols (comma-separated, required)"
              hint="Runs are bounded to the symbols you choose, e.g. AAPL, MSFT."
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
            />
          )}
          <TextInput
            label="Checkout contact email"
            hint="Used only as the checkout contact. Identity comes from your signed-in session."
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p>
            Price per run-request: <strong>{priceFor(family)}</strong>
          </p>
          {pricing?.failurePolicy && <Notice tone="info">{pricing.failurePolicy}</Notice>}
          {pricing && (
            <p>
              {pricing.browserPaymentScope === "card-only"
                ? "Card is the browser payment rail."
                : "Crypto (x402) is enabled for API/agent callers; card remains the payment rail in this panel."}
            </p>
          )}
          {pricing?.monetizationEnabled && (
            <Checkbox label="I authorize this charge at submission (one-off run only; recurring schedules are never card-charged)." checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
          )}
          {submitError && <Notice tone="danger">{submitError}</Notice>}
          <Button variant="primary" loading={submitting} onClick={handlePay}>
            {pricing?.monetizationEnabled ? `Pay ${priceFor(family)} and run` : "Run for free"}
          </Button>
          {submitResult && (
            <Card>
              <p>
                Run request: <code>{submitResult.runRequestId}</code>
              </p>
              {submitResult.status === "redeemed_started" && (
                <Notice tone="success">
                  A failure credit covered this run — no charge. Credit run: {submitResult.creditRunId}. Workflow:{" "}
                  {submitResult.workflowId}.
                </Notice>
              )}
              {submitResult.status === "payment_started" && (
                <>
                  <Notice tone="info">
                    Payment workflow started (workflow {submitResult.workflowId}). Complete the payment for this
                    request, then tap “I have paid — verify” below.
                  </Notice>
                  {quotaOffer && quotaOfferFamily ? (
                    <UpgradeOffer
                      trigger="quota_exhausted"
                      family={quotaOfferFamily}
                      fallback={
                        runStatus ?? codedMessage("FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED")
                      }
                    />
                  ) : (
                    <p>
                      Workflow status: {runStatus ?? "starting…"} {polling && <Spinner size="sm" />}
                    </p>
                  )}
                  <Button loading={checking} onClick={handleCheckPayment}>
                    I have paid — verify
                  </Button>{" "}
                  <Button variant="ghost" onClick={() => setPolling(false)}>
                    Stop status polling
                  </Button>
                  {checkResult && <Notice tone="info">{checkResult}</Notice>}
                  {checkPaymentUrl && (
                    <p>
                      <a href={checkPaymentUrl} target="_blank" rel="noreferrer">
                        Complete payment
                      </a>{" "}
                      (native checkout link for this checkout)
                    </p>
                  )}
                  {checkChallenge && (
                    <Notice tone="info">
                      <p>
                        Crypto (x402) payment for this run — no payment link exists for crypto. Complete the 402
                        payment with your wallet or agent, then verify below.
                      </p>
                      <p>
                        Network: {checkChallenge.network ?? "—"}
                        {checkChallenge.amountUSD !== undefined && <> — amount: {formatUSD(checkChallenge.amountUSD)} USDC</>}
                        {checkChallenge.recipient && <> — recipient: {checkChallenge.recipient}</>}
                      </p>
                      <p>{checkChallenge.note}</p>
                    </Notice>
                  )}
                </>
              )}
            </Card>
          )}
        </Card>
      )}
      {tab === "subscriptions" && (
        <Card>
          {!subsDeployed && (
            <Notice tone="warning">
              Subscription service is not available from this deployment yet.
              Plans, purchase, and cancel will appear here once the deployed backend serves the subscription routes.
            </Notice>
          )}
          {subsDeployed && (
            <>
              <Notice tone="info">
                Subscriptions do not auto-renew: renewal is repurchase before expiry. Canceling stops future
                charges and does not itself issue a cash refund. Whether access runs to the end of the current
                period depends on the store&apos;s billing policy — the result shown after you confirm states the
                actual end date.
              </Notice>
              <Notice tone="info">
                Provider-managed (Billing) subscriptions are purchased from the{" "}
                <a href="?tab=products">Products catalog</a>. This panel buys native subscriptions — and cancels
                subscriptions of either kind.
              </Notice>
              {subStatus && (
                <p>
                  Signed in as <strong>{userLogin}</strong> — effective tier:{" "}
                  <strong>{subStatus.effectiveTier}</strong>
                  {subStatus.current && (
                    <>
                      {" "}
                      — current subscription runs through{" "}
                      {formatPeriodEnd(subStatus.current.periodEndMs)}
                      {subStatus.current.canceledAtMs ? " (canceled, access continues to period end)" : ""}.
                    </>
                  )}
                </p>
              )}
              {/* Issue #3246: the ambient plan comparison. It fetches
                  the server-computed offer and renders nothing on any
                  failure — the plans table below is unaffected. */}
              <AmbientOfferCompare
                onChoosePlan={handleCompareChoose}
                onBuyCredits={handleCompareBuyCredits}
                onBuyPack={handleCompareBuyPack}
                selectedPackVersionId={preselectedPackVersionId}
              />
              {plans && plans.length > 0 ? (
                <Table
                  columns={[
                    {
                      key: "name",
                      header: "Plan",
                      render: (row: PlanView) => (
                        <>
                          {row.name}
                          {preselectedPlanId === row.id && (
                            <>
                              {" "}
                              <Badge tone="accent">Selected from your plan comparison</Badge>
                            </>
                          )}
                        </>
                      ),
                    },
                    { key: "price", header: "Price", render: (row: PlanView) => formatUSD(row.priceUSD), align: "right" },
                    {
                      key: "period",
                      header: "Period (days)",
                      render: (row: PlanView) => String(row.periodDays),
                      align: "right",
                    },
                    {
                      key: "runs",
                      header: "Included runs",
                      render: (row: PlanView) => String(row.includedRuns),
                      align: "right",
                    },
                    {
                      key: "buy",
                      header: "",
                      render: (row: PlanView) => (
                        <Button size="sm" loading={buying && buyPlan?.id === row.id} onClick={() => handleBuyCheckout(row)}>
                          Buy
                        </Button>
                      ),
                    },
                  ]}
                  rows={plans}
                  rowKey={(row) => row.id}
                  caption="Subscription plans"
                  empty={<EmptyState title="No plans available" description="An operator creates plans; none are active right now." />}
                />
              ) : (
                <EmptyState
                  title="No plans available"
                  description="An operator creates plans; none are active right now."
                />
              )}
              <TextInput
                label="Checkout contact email"
                hint="Used only as the checkout contact."
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {buyError && <Notice tone="danger">{buyError}</Notice>}
              {buyCheckoutId && buyPlan && (
                <Notice tone="info">
                  Checkout created for {buyPlan.name} ({formatUSD(buyPlan.priceUSD)}). Complete the payment for
                  checkout {buyCheckoutId}, then confirm below.
                  {buyCheckoutUrl && (
                    <p>
                      <a href={buyCheckoutUrl} target="_blank" rel="noreferrer">
                        Complete payment
                      </a>{" "}
                      (native checkout link for this subscription checkout)
                    </p>
                  )}
                  <div>
                    <Button variant="primary" loading={buying} onClick={handleBuyPurchase}>
                      I have paid — activate subscription
                    </Button>
                  </div>
                </Notice>
              )}
              {buyDone && <Notice tone="success">{buyDone}</Notice>}
              {/* Issue #3246 slice 3 — the runs-pack purchase picked
                  in the ambient compare above. The pack is a marker
                  only until the operator of this panel mints it:
                  runs + price verbatim from the offer payload, rail
                  card by default (x402 only when offered), then the
                  same verified-payment mint/confirm pair as top-up.
                  A pack never changes the plan or subscription. */}
              {pendingPack && (
                <Notice tone="info">
                  Runs pack: {pendingPack.pack.name} — {pendingPack.pack.runs} runs for{" "}
                  {formatUSD(pendingPack.pack.priceUSD)}. Pack runs spend after your included runs and before your
                  credits, and only while the run&apos;s price is approved.
                  <div>
                    <Select
                      label="Payment rail"
                      value={packRail}
                      onChange={(e) => setPackRail(e.target.value as "card" | "x402")}
                    >
                      <option value="card">Card (Stripe)</option>
                      {topUpX402Offered && <option value="x402">Crypto (x402)</option>}
                    </Select>
                  </div>
                  <div>
                    <Button variant="primary" loading={packMinting} onClick={handlePackMint}>
                      Create pack checkout
                    </Button>
                  </div>
                </Notice>
              )}
              {packError && <Notice tone="danger">{packError}</Notice>}
              {packMint && (
                <Notice tone="info">
                  Checkout created for {packMint.runs} runs ({formatUSD(packMint.priceUSD)}) (
                  {packMint.packRequestId}). Complete the payment, then confirm below.
                  {packMint.rail === "card" && packMint.checkoutUrl && (
                    <p>
                      <a className="ui-link" href={packMint.checkoutUrl} target="_blank" rel="noreferrer">
                        Complete payment (opens in a new tab)
                      </a>{" "}
                      (native checkout link for this runs pack)
                    </p>
                  )}
                  {packMint.rail === "x402" && packMint.challenge && (
                    <>
                      <p>
                        Crypto (x402) payment — no payment link exists for crypto. Complete the 402 payment with your
                        wallet or agent, then paste the payment proof below.
                      </p>
                      <p>
                        Network: {packMint.challenge.network} — amount: {formatUSD(packMint.challenge.amountUSD)}{" "}
                        USDC — recipient: {packMint.challenge.recipient}
                      </p>
                      <TextInput
                        label="Payment proof"
                        hint="The proof your wallet or agent returned for this 402 payment."
                        value={packProof}
                        onChange={(e) => {
                          setPackProof(e.target.value);
                          setPackError(null);
                        }}
                      />
                    </>
                  )}
                  <div>
                    <Button variant="primary" loading={packConfirming} onClick={handlePackConfirm}>
                      I have paid — verify
                    </Button>
                  </div>
                </Notice>
              )}
              {packDone && <Notice tone="success">{packDone}</Notice>}
              {cancelableSubs.length > 0 && (
                <Button
                  variant="danger"
                  loading={canceling}
                  onClick={() => {
                    setCancelDone(null);
                    setCancelDetail(null);
                    setCancelConfirmOpen(true);
                  }}
                >
                  Cancel subscription…
                </Button>
              )}
              <Modal
                open={cancelConfirmOpen}
                onClose={() => setCancelConfirmOpen(false)}
                title="Cancel subscription"
                footer={
                  <>
                    <Button onClick={() => setCancelConfirmOpen(false)} disabled={canceling}>
                      Keep subscriptions
                    </Button>
                    <Button variant="danger" loading={canceling} onClick={handleCancel}>
                      Yes, cancel subscriptions
                    </Button>
                  </>
                }
              >
                <p>
                  This cancels{" "}
                  {cancelableSubs.length === 1
                    ? "this subscription"
                    : `all ${cancelableSubs.length} active subscriptions`}
                  . Billing-managed rows are provider-canceled first (Stripe stops charging); native rows are
                  canceled locally. Canceling does not itself issue a cash refund.
                </p>
                <Table
                  columns={[
                    { key: "plan", header: "Plan", render: (row: SubscriptionView) => row.planId },
                    { key: "managedBy", header: "Managed by", render: (row: SubscriptionView) => managedByLabel(row) },
                    { key: "end", header: "Period end", render: (row: SubscriptionView) => formatPeriodEnd(row.periodEndMs) },
                  ]}
                  rows={cancelableSubs}
                  rowKey={(row) => row.id}
                  caption="Subscriptions to cancel"
                  empty={
                    <EmptyState title="No active subscription" description="No active subscription was found to cancel." />
                  }
                />
              </Modal>
              {cancelDone && (
                <Notice tone="info">
                  {cancelDone}
                  {cancelDetail && <p>{cancelDetail}</p>}
                </Notice>
              )}
              {subStatus && subStatus.subscriptions.length > 0 && (
                <Table
                  columns={[
                    { key: "plan", header: "Plan", render: (row) => row.planId },
                    { key: "managedBy", header: "Managed by", render: (row) => managedByLabel(row) },
                    { key: "status", header: "Status", render: (row) => row.status },
                    { key: "end", header: "Period end", render: (row) => formatPeriodEnd(row.periodEndMs) },
                  ]}
                  rows={subStatus.subscriptions}
                  rowKey={(row) => row.id}
                  caption="Your subscriptions"
                />
              )}
              <p>
                {pricing && !pricing.network.acceptsMainnet ? (
                  <>
                    <Badge tone="neutral">Testnet only</Badge> No mainnet payment is accepted by this build.
                  </>
                ) : (
                  <>Payments are accepted on the networks the payment gate allows; see the pay-per-run section for the current network policy.</>
                )}
              </p>
            </>
          )}
        </Card>
      )}
      <TabPanel idBase="checkout-tabs" tabId="topup" active={tab === "topup"}>
        <Card>
          <Notice tone="info">
            Add money to your account: credits fund pay-per-run screens. Credit lands only after verified
            payment — never on an unconfirmed checkout.
          </Notice>
          {pricing?.topUpLimits ? (
            <p>
              Top-up limits: {formatUSD(pricing.topUpLimits.minUSD)} – {formatUSD(pricing.topUpLimits.maxUSD)}{" "}
              per top-up (operator-set).
            </p>
          ) : (
            <p>Top-up limits are currently unavailable — the server still validates the amount.</p>
          )}
          <TextInput
            label="Amount (USD)"
            hint="Credits added to your account after verified payment."
            type="number"
            value={topUpAmount}
            onChange={(e) => {
              setTopUpAmount(e.target.value);
              setTopUpAmountError(null);
            }}
            ref={topUpAmountRef}
            error={topUpAmountError ?? undefined}
          />
          <Select label="Payment rail" value={topUpRail} onChange={(e) => setTopUpRail(e.target.value as "card" | "x402")}>
            <option value="card">Card (Stripe)</option>
            {topUpX402Offered && <option value="x402">Crypto (x402)</option>}
          </Select>
          <TextInput
            label="Checkout contact email"
            hint="Used only as the checkout contact. Identity comes from your signed-in session."
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setTopUpEmailError(null);
            }}
            ref={topUpEmailRef}
            error={topUpEmailError ?? undefined}
          />
          {topUpError && <Notice tone="danger">{topUpError}</Notice>}
          <Button variant="primary" loading={topUpMinting} onClick={handleTopUpMint}>
            Create top-up checkout
          </Button>
          {topUpMint && (
            <Notice tone="info">
              {/* Issue #3571: the mint notice renders the catalog
                  message for the outcome the 200 already proves —
                  never a hand-written sentence. Amount and request id
                  stay below as data, not message text. */}
              {codedMessage(topUpMint.code ?? "SUCCESS_TOP_UP_CHECKOUT_CREATED")}
              <p>
                Checkout created for {formatUSD(topUpMint.amountUSD)} ({topUpMint.topUpRequestId}).
              </p>
              {topUpMint.rail === "card" && topUpMint.checkoutUrl && (
                <p>
                  <a className="ui-link" href={topUpMint.checkoutUrl} target="_blank" rel="noreferrer">
                    Complete payment (opens in a new tab)
                  </a>{" "}
                  (native checkout link for this top-up)
                </p>
              )}
              {topUpMint.rail === "x402" && topUpMint.challenge && (
                <>
                  <p>
                    Crypto (x402) payment — no payment link exists for crypto. Complete the 402 payment with your
                    wallet or agent, then paste the payment proof below.
                  </p>
                  <p>
                    Network: {topUpMint.challenge.network} — amount: {formatUSD(topUpMint.challenge.amountUSD)}{" "}
                    USDC — recipient: {topUpMint.challenge.recipient}
                  </p>
                  <TextInput
                    label="Payment proof"
                    hint="The proof your wallet or agent returned for this 402 payment."
                    value={topUpProof}
                    onChange={(e) => {
                      setTopUpProof(e.target.value);
                      setTopUpProofError(null);
                    }}
                    ref={topUpProofRef}
                    error={topUpProofError ?? undefined}
                  />
                </>
              )}
              <div>
                <Button variant="primary" loading={topUpConfirming} onClick={handleTopUpConfirm}>
                  I have paid — verify
                </Button>
              </div>
            </Notice>
          )}
          {topUpDone && <Notice tone="success">{topUpDone}</Notice>}
        </Card>
      </TabPanel>
    </PageShell>
  );
}
