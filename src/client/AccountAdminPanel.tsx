/**
 * Issue #2222 (program #2218, slice 4) — account administration
 * panel for the Platform Admin page ("Accounts" tab).
 *
 * Two surfaces in one panel, both read through the platform
 * account routes (src/agents/routes/platformAccounts.ts):
 *
 * SELF-SERVICE (every signed-in user): the read-only identity
 * (user, tenant, tier, credits, included runs) that the payment
 * screen also displays, plus subscriptions and price-catalogue
 * bindings. When no account exists, the panel offers the account
 * SETUP flow — the destination of slice 1's paid-path no-account
 * message — which creates the commercial account server-side
 * from the verified session identity (tenant = resolved tenant
 * ?? login, Free tier). Setup never asks for a tenant id, and
 * free runs never require an account: the free path stays
 * first-class and proceeds without setup.
 *
 * OPERATOR (store operators only): lookup by verified login,
 * then mutation through the EXISTING operator-gated commercial
 * routes (POST /payments/agentic/commercial/account for
 * tier/credits/included-runs upserts, POST
 * /payments/agentic/commercial/account/credits for credit
 * adjustments). This panel invents no credit-granting path: a
 * 403 from those routes means the server refused, never a
 * client bug, and the mutation forms only appear after a
 * successful operator lookup prefills the target's tenant.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 * Editing tenant/user/account lives here, never on the payment
 * screen: the payment screen shows this identity read-only.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Notice,
  Select,
  Spinner,
  Stack,
  Table,
  TextInput,
} from "./components/ui";
import { apiFetch } from "./apiFetch";
import { SubscriptionGrantSection } from "./SubscriptionGrantSection";
import { UnlimitedFreeGrantSection } from "./UnlimitedFreeGrantSection";
import { AccountVersionMoveSection } from "./AccountVersionMoveSection";

export interface AccountIdentityView {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
}

export interface AccountSubscriptionView {
  id: string;
  planId: string;
  provider: string;
  providerStatus: string | null;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
}

export interface AccountCatalogueView {
  family: string;
  priceUSD: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAtMs: number | null;
  updatedAtMs: number;
}

export interface AccountView {
  identity: AccountIdentityView;
  subscriptions: AccountSubscriptionView[];
  catalogue: AccountCatalogueView[];
  catalogueAvailable: boolean;
}

function isAccountView(value: unknown): value is AccountView {
  if (typeof value !== "object" || value === null) return false;
  const view = value as Record<string, unknown>;
  const identity = view.identity as Record<string, unknown> | undefined;
  return (
    typeof identity?.userLogin === "string" &&
    typeof identity?.hasAccount === "boolean" &&
    Array.isArray(view.subscriptions) &&
    Array.isArray(view.catalogue) &&
    typeof view.catalogueAvailable === "boolean"
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function fmtMoney(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function fmtDate(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  return new Date(ms).toLocaleString();
}

function IdentityBlock({ view }: { view: AccountView }) {
  const { identity } = view;
  return (
    <Stack gap="1">
      <div>
        <strong>Signed-in account:</strong> {identity.userLogin}
      </div>
      <div>
        <strong>Tenant:</strong> {identity.tenantId ?? "No account set up yet"}
      </div>
      <div>
        <strong>Tier:</strong> {identity.tier}
      </div>
      <div>
        <strong>Credits:</strong> {fmtMoney(identity.creditsUSD)}
      </div>
      <div>
        <strong>Included runs remaining:</strong> {identity.includedRunsRemaining}
      </div>
      <div>
        <strong>Account on file:</strong> {identity.hasAccount ? "Yes" : "No — free runs still work without one"}
      </div>
    </Stack>
  );
}

export function AccountAdminPanel() {
  const [self, setSelf] = useState<AccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingUp, setSettingUp] = useState(false);
  const [setupNote, setSetupNote] = useState("");

  const [lookupLogin, setLookupLogin] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookup, setLookup] = useState<AccountView | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [mutationNote, setMutationNote] = useState("");
  const [tier, setTier] = useState("Free");
  const [credits, setCredits] = useState("");
  const [includedRuns, setIncludedRuns] = useState("");
  const [creditDelta, setCreditDelta] = useState("");

  const loadSelf = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/platform/accounts/self");
      const data = await readJson(res);
      if (!res.ok) {
        setError(data.error as string || "Could not load your account.");
        setSelf(null);
        return;
      }
      if (!isAccountView(data)) {
        setError("Unexpected account response from the server.");
        setSelf(null);
        return;
      }
      setSelf(data);
    } catch {
      setError("Could not load your account.");
      setSelf(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSelf();
  }, [loadSelf]);

  const runSetup = useCallback(async () => {
    setSettingUp(true);
    setSetupNote("");
    try {
      const res = await apiFetch("/api/platform/accounts/setup", { method: "POST" });
      const data = await readJson(res);
      if (!res.ok) {
        setSetupNote(data.error as string || "Account setup failed.");
        return;
      }
      setSetupNote(
        data.created === true
          ? "Account set up. Paid runs can now resolve your account; free runs were never blocked."
          : "An account already exists for your signed-in account — nothing was changed.",
      );
      await loadSelf();
    } catch {
      setSetupNote("Account setup failed.");
    } finally {
      setSettingUp(false);
    }
  }, [loadSelf]);

  const runLookup = useCallback(async () => {
    const target = lookupLogin.trim();
    if (!target) {
      setLookupError("Enter a signed-in login to look up.");
      return;
    }
    setLookingUp(true);
    setLookupError("");
    setLookup(null);
    setMutationNote("");
    try {
      const res = await apiFetch(`/api/platform/accounts/lookup?userId=${encodeURIComponent(target)}`);
      const data = await readJson(res);
      if (!res.ok) {
        setLookupError(
          res.status === 403
            ? "Operator access required: only store operators may look up other accounts."
            : (data.error as string) || "Lookup failed.",
        );
        return;
      }
      if (!isAccountView(data)) {
        setLookupError("Unexpected account response from the server.");
        return;
      }
      setLookup(data);
      setTier(data.identity.tier);
      setCredits(String(data.identity.creditsUSD));
      setIncludedRuns(String(data.identity.includedRunsRemaining));
    } catch {
      setLookupError("Lookup failed.");
    } finally {
      setLookingUp(false);
    }
  }, [lookupLogin]);

  const runUpsert = useCallback(async () => {
    if (!lookup) return;
    setMutating(true);
    setMutationNote("");
    try {
      const res = await apiFetch("/api/payments/agentic/commercial/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: lookup.identity.userLogin,
          tenantId: lookup.identity.tenantId ?? lookup.identity.userLogin,
          tier,
          creditsUSD: credits === "" ? undefined : Number(credits),
          includedRuns: includedRuns === "" ? undefined : Number(includedRuns),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setMutationNote(data.error as string || "Account update failed.");
        return;
      }
      setMutationNote("Account updated.");
      await runLookup();
    } catch {
      setMutationNote("Account update failed.");
    } finally {
      setMutating(false);
    }
  }, [lookup, tier, credits, includedRuns, runLookup]);

  const runCreditAdjust = useCallback(async () => {
    if (!lookup) return;
    const delta = Number(creditDelta);
    if (!Number.isFinite(delta)) {
      setMutationNote("Enter a finite credit amount to adjust by.");
      return;
    }
    setMutating(true);
    setMutationNote("");
    try {
      const res = await apiFetch("/api/payments/agentic/commercial/account/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: lookup.identity.userLogin, deltaUSD: delta }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setMutationNote(data.error as string || "Credit adjustment failed.");
        return;
      }
      setMutationNote(`Credits adjusted by ${fmtMoney(delta)}.`);
      setCreditDelta("");
      await runLookup();
    } catch {
      setMutationNote("Credit adjustment failed.");
    } finally {
      setMutating(false);
    }
  }, [lookup, creditDelta, runLookup]);

  if (loading) return <Spinner />;
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!self) return <EmptyState title="No account data" description="Reload the page to try again." />;

  return (
    <Stack gap="2">
      <div>
        <h3>Your account</h3>
        <p>
          This is the read-only identity the payment screen shows for your
          signed-in account. Editing happens here, never on the payment screen.
        </p>
        <IdentityBlock view={self} />
      </div>

      {!self.identity.hasAccount && (
        <Stack gap="1">
          <Notice tone="info">
            No commercial account is set up for your signed-in account yet. Paid
            runs fail closed until one exists; free runs work without one.
          </Notice>
          <div>
            <Button onClick={() => void runSetup()} loading={settingUp}>
              Set up account
            </Button>
          </div>
          {setupNote && <Notice tone="info">{setupNote}</Notice>}
        </Stack>
      )}
      {self.identity.hasAccount && setupNote && <Notice tone="info">{setupNote}</Notice>}

      <div>
        <h3>Subscriptions</h3>
        {self.subscriptions.length === 0 ? (
          <EmptyState title="No subscriptions" description="No subscription rows exist for this account." />
        ) : (
          <Table<AccountSubscriptionView>
            rowKey={(row) => row.id}
            columns={[
              { key: "plan", header: "Plan", render: (row) => row.planId },
              { key: "provider", header: "Provider", render: (row) => row.provider },
              { key: "status", header: "Status", render: (row) => `${row.status}${row.providerStatus ? ` (${row.providerStatus})` : ""}` },
              { key: "periodEnd", header: "Period ends", render: (row) => fmtDate(row.periodEndMs) },
              { key: "canceled", header: "Canceled at", render: (row) => fmtDate(row.canceledAtMs) },
            ]}
            rows={self.subscriptions}
          />
        )}
      </div>

      <SubscriptionGrantSection
        targetLogin={lookup?.identity.userLogin ?? null}
        onGranted={() => void runLookup()}
      />

      <div>
        <h3>Price catalogue bindings</h3>
        {!self.catalogueAvailable ? (
          <Notice tone="warning">
            The price catalogue is unavailable — prices are not shown rather than
            shown as an empty list. Missing catalogue data fails closed for charging.
          </Notice>
        ) : self.catalogue.length === 0 ? (
          <EmptyState title="No catalogue prices" description="No price rows exist for any screener family." />
        ) : (
          <>
            <p>
              Only approved prices can be charged; proposed prices are operator
              proposals awaiting approval and are not active.
            </p>
            <Table<AccountCatalogueView>
              rowKey={(row) => row.family}
              columns={[
                { key: "family", header: "Family", render: (row) => row.family },
                { key: "price", header: "Price", render: (row) => fmtMoney(row.priceUSD) },
                { key: "approval", header: "Approval", render: (row) => row.approvalStatus },
                { key: "approvedBy", header: "Approved by", render: (row) => row.approvedBy ?? "—" },
              ]}
              rows={self.catalogue}
            />
          </>
        )}
      </div>

      <div>
        <h3>Operator lookup</h3>
        <p>
          Operators look up an account by the owner&apos;s signed-in login. This
          is a lookup, not tenant scoping: the account&apos;s tenant always
          comes from its stored row.
        </p>
        <Stack gap="1">
          <TextInput
            label="Signed-in login to look up"
            value={lookupLogin}
            onChange={(event) => setLookupLogin(event.target.value)}
          />
          <div>
            <Button onClick={() => void runLookup()} loading={lookingUp}>
              Look up account
            </Button>
          </div>
          {lookupError && <Notice tone="danger">{lookupError}</Notice>}
        </Stack>
        {lookup && (
          <Stack gap="2">
            <IdentityBlock view={lookup} />
            <Stack gap="1">
              <h4>Update tier and coverage (operator)</h4>
              <p>
                This writes through the existing operator-gated commercial
                account route; it creates no new credit path.
              </p>
              <Select label="Tier" value={tier} onChange={(event) => setTier(event.target.value)}>
                <option value="Free">Free</option>
                <option value="PayPerUse">PayPerUse</option>
                <option value="Subscribed">Subscribed</option>
              </Select>
              <TextInput
                label="Credits (USD)"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
              />
              <TextInput
                label="Included runs"
                value={includedRuns}
                onChange={(event) => setIncludedRuns(event.target.value)}
              />
              <div>
                <Button onClick={() => void runUpsert()} loading={mutating}>
                  Save account
                </Button>
              </div>
              <TextInput
                label="Credit adjustment (USD, negative to remove)"
                value={creditDelta}
                onChange={(event) => setCreditDelta(event.target.value)}
              />
              <div>
                <Button onClick={() => void runCreditAdjust()} loading={mutating}>
                  Adjust credits
                </Button>
              </div>
              {mutationNote && <Notice tone="info">{mutationNote}</Notice>}
            </Stack>
            {/* Issue #3245: unlimited-free grant, anchored after the
                tier/coverage section. The section reads/writes the
                looked-up account through the commercial account
                route itself. */}
            <UnlimitedFreeGrantSection userId={lookup.identity.userLogin} />
            {/* Issue #3289 slice 2: per-customer version move +
                segment assignment, beside the grant section. The
                section reads the looked-up account's segment and
                the product chains through the commercial routes
                itself; the panel passes the looked-up
                subscriptions it already holds. */}
            <AccountVersionMoveSection
              userId={lookup.identity.userLogin}
              subscriptions={lookup.subscriptions}
            />
          </Stack>
        )}
      </div>
    </Stack>
  );
}
