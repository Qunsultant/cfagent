/**
 * Issue #2137: user-facing checkout UI — pay for a run, or buy, view,
 * and cancel a subscription.
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
  Notice,
  PageShell,
  Select,
  Spinner,
  Table,
  Tabs,
  TextInput,
} from "./components/ui";
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
  listPlans,
  parseSymbols,
  submitRun,
  subscriptionCancel,
  subscriptionCheckout,
  subscriptionPurchase,
  type ChallengeFlow,
  type CommercialAccountView,
  type PlatformIdentityView,
  type PlanView,
  type Pricing,
  type ScreenerFamily,
  type SubmitResult,
  type SubscriptionStatusView,
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

function newJobId(): string {
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CheckoutPanel({ userLogin }: { userLogin: string }) {
  const [tab, setTab] = React.useState<"pay" | "subscriptions">("pay");
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
  React.useEffect(() => {
    if (!submitResult?.workflowId || submitResult.status === "redeemed_started" || !polling) return;
    let stopped = false;
    let polls = 0;
    const tick = async () => {
      if (stopped || polls >= 60) {
        setPolling(false);
        return;
      }
      polls += 1;
      try {
        const res = await getSubmissionStatus(submitResult.workflowId!);
        if (!stopped) setRunStatus(res.status);
      } catch {
        // A transient status-read failure stops polling; the user can
        // still use the verify button and re-read status manually.
        if (!stopped) setPolling(false);
      }
      if (!stopped) setTimeout(tick, 5000);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [submitResult, polling]);

  const priceFor = (f: ScreenerFamily): string =>
    pricing ? formatUSD(pricing.prices[f]) : "unavailable";

  const handlePay = async () => {
    setSubmitError(null);
    setSubmitResult(null);
    setRunStatus(null);
    setCheckResult(null);
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
      const res = await subscriptionCheckout({ planId: plan.id, email: email.trim() });
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
    setCanceling(true);
    setCancelDone(null);
    setBuyError(null);
    try {
      const res = await subscriptionCancel();
      setCancelDone(
        res.accessThroughMs
          ? `Canceled. Your access continues through ${formatPeriodEnd(res.accessThroughMs)}. No cash refund is issued.`
          : "No active subscription was found to cancel."
      );
      await refreshSubscription();
    } catch (err) {
      setBuyError(errText(err));
    } finally {
      setCanceling(false);
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
        ]}
        value={tab}
        onChange={(v) => setTab(v as "pay" | "subscriptions")}
        idBase="checkout-tabs"
        ariaLabel="Checkout sections"
      />
      {/* #2219: read-only identity display, shared by both tabs.
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
            <label>
              <Checkbox checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> I authorize this
              charge at submission (one-off run only; recurring schedules are never card-charged).
            </label>
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
                  <p>
                    Workflow status: {runStatus ?? "starting…"} {polling && <Spinner size="sm" />}
                  </p>
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
                Subscriptions do not auto-renew: renewal is repurchase before expiry. Canceling keeps your access
                through the end of the current period; canceling does not itself issue a cash refund.
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
              {plans && plans.length > 0 ? (
                <Table
                  columns={[
                    { key: "name", header: "Plan", render: (row: PlanView) => row.name },
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
              {subStatus?.current && (
                <Button variant="danger" loading={canceling} onClick={handleCancel}>
                  Cancel subscription (access continues to period end)
                </Button>
              )}
              {cancelDone && <Notice tone="info">{cancelDone}</Notice>}
              {subStatus && subStatus.subscriptions.length > 0 && (
                <Table
                  columns={[
                    { key: "plan", header: "Plan", render: (row) => row.planId },
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
    </PageShell>
  );
}
