/**
 * Issue #3244 (slice 2 of #3241) — operator subscription grant
 * section for the Accounts panel.
 *
 * An operator picks an ACTIVE plan and grants it to the account
 * the operator looked up below. The grant POSTs to the operator
 * grant route (POST /payments/agentic/commercial/subscription/
 * grant): the server creates the subscription row AND bumps the
 * target account's included runs, mirroring a purchase — no
 * checkout is involved and no Stripe record is created. The
 * grant runs for the plan's period; at expiry the effective tier
 * falls back and the normal gate resumes.
 *
 * The target is the looked-up login passed in as a prop: this
 * section never takes a login of its own, and it never sends a
 * tenantId — the server resolves the tenant from the target
 * account row. Until an account is looked up the grant button
 * stays disabled with a hint pointing at the lookup section.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through src/client/apiFetch.ts (the #71 rule) and
 * the shared commercialApi listPlans helper.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Select, Stack } from "./components/ui";
import { apiFetch } from "./apiFetch";
import { listPlans, type PlanView } from "./commercialApi";

import { commercialPath } from "../data/commercialUrlCatalog";
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SubscriptionGrantSection({
  targetLogin,
  onGranted,
}: {
  targetLogin: string | null;
  onGranted: () => void;
}) {
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [plansError, setPlansError] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [granting, setGranting] = useState(false);
  const [note, setNote] = useState("");
  const [grantError, setGrantError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listPlans()
      .then((result) => {
        if (cancelled) return;
        setPlans(result.plans);
        if (result.plans.length > 0) setSelectedPlanId(result.plans[0].id);
      })
      .catch(() => {
        if (cancelled) return;
        setPlansError("Could not load subscription plans.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runGrant = useCallback(async () => {
    if (!targetLogin || !selectedPlanId) return;
    setGranting(true);
    setNote("");
    setGrantError("");
    try {
      const res = await apiFetch(commercialPath("subscriptionGrant"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetLogin, planId: selectedPlanId }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setGrantError((data.error as string) || "Subscription grant failed.");
        return;
      }
      const subscription = data.subscription as { periodEndMs?: number } | undefined;
      const account = data.account as { includedRuns?: number } | undefined;
      const plan = plans?.find((p) => p.id === selectedPlanId);
      setNote(
        `Granted ${plan ? plan.name : selectedPlanId} to ${targetLogin}` +
          `${account?.includedRuns !== undefined ? ` — account now holds ${account.includedRuns} included runs` : ""}` +
          `${subscription?.periodEndMs ? ` — coverage runs through ${fmtDate(subscription.periodEndMs)}, then the tier falls back.` : "."}`,
      );
      onGranted();
    } catch {
      setGrantError("Subscription grant failed.");
    } finally {
      setGranting(false);
    }
  }, [targetLogin, selectedPlanId, plans, onGranted]);

  return (
    <div>
      <h3>Grant subscription (operator)</h3>
      <p>
        Grant an active plan to the looked-up account. The grant
        creates the subscription row and adds the plan&apos;s
        included runs to the account — the same coverage a purchase
        confers — for the plan&apos;s period. No checkout is
        involved and no Stripe record is created. At expiry the
        tier falls back and the normal gate resumes.
      </p>
      <Stack gap="1">
        {plansError && <Notice tone="danger">{plansError}</Notice>}
        {plans !== null && plans.length === 0 && (
          <Notice tone="info">No active subscription plans — an operator creates plans first.</Notice>
        )}
        {plans !== null && plans.length > 0 && (
          <Select
            label="Plan to grant"
            value={selectedPlanId}
            onChange={(event) => setSelectedPlanId(event.target.value)}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} — ${plan.priceUSD.toFixed(2)} / {plan.periodDays} days, {plan.includedRuns} included runs
              </option>
            ))}
          </Select>
        )}
        {!targetLogin && (
          <Notice tone="info">
            Look up an account in the Operator lookup section below first — the grant goes to that account.
          </Notice>
        )}
        <div>
          <Button
            onClick={() => void runGrant()}
            loading={granting}
            disabled={!targetLogin || !selectedPlanId}
          >
            Grant subscription
          </Button>
        </div>
        {grantError && <Notice tone="danger">{grantError}</Notice>}
        {note && <Notice tone="info">{note}</Notice>}
      </Stack>
    </div>
  );
}
