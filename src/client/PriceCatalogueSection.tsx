/**
 * Issue #5230 — per-run price catalogue editor in the Product Hub
 * admin-products tab.
 *
 * This section CALLS existing routes only and creates none: GET
 * prices (operator-only) for the effective catalogue entries with
 * approval state, POST prices (operator-only) for price edits and
 * for the separate explicit approval action, and GET operators
 * (operator-only) to learn whether the viewer is an operator. The
 * server routes remain the access control — a non-operator sees a
 * fixed note with no values and no edit controls, because the
 * operators read refused them; nothing here enforces anything the
 * server does not.
 *
 * Price discipline (server-enforced, #2547): a price write lands
 * PROPOSED and clears any prior approval; only an APPROVED price may
 * be charged. Approval is a separate, explicit operator action and
 * records this verified operator login as the approver. After every
 * save the section re-reads the entries and renders ONLY the fresh
 * read, never the POST answer and never an optimistic assertion.
 * Failures render as fixed strings keyed by HTTP status; server
 * error bodies are never rendered. Changing a price never affects a
 * run already charged; the gate reads the stored catalogue, not
 * code. ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { PageShell } from "./components/ui/PageShell";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { formatUSD } from "./commercialApi";
import { listOperators } from "./refundPolicyApi";
import {
  getPriceEntries,
  setPrice,
  approvePrice,
  isPremiumPriceFamily,
  PriceCatalogueApiError,
  type PriceEntryView,
  type PriceFamily,
} from "./priceCatalogueApi";

function statusOf(error: unknown): number {
  return error instanceof PriceCatalogueApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The per-run prices are not configured yet.";
  return "The per-run prices could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400) return "The price is invalid: enter a positive amount in USD.";
  if (status === 403) return "Only a store operator can change per-run prices.";
  if (status === 503) return "The billing service is temporarily unavailable. Try again later.";
  return "The price could not be saved. Try again later.";
}

function approvalLabel(entry: PriceEntryView): string {
  if (entry.approvalStatus === "approved") {
    const by = entry.approvedBy ? ` by ${entry.approvedBy}` : "";
    const at = entry.approvedAtMs
      ? ` on ${new Date(entry.approvedAtMs).toLocaleDateString()}`
      : "";
    return `Approved${by}${at}`;
  }
  return "Proposed — not chargeable until approved";
}

export function PriceCatalogueSection() {
  const [entries, setEntries] = useState<PriceEntryView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingFamily, setSavingFamily] = useState<PriceFamily | null>(null);
  const [approvingFamily, setApprovingFamily] = useState<PriceFamily | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [entriesResult, operatorsResult] = await Promise.allSettled([
        getPriceEntries(),
        listOperators(),
      ]);
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the fixed note; the server
      // still refuses any action the UI should not offer.
      const operator = operatorsResult.status === "fulfilled";
      setIsOperator(operator);
      if (operator && entriesResult.status === "fulfilled") {
        setEntries(entriesResult.value.entries);
        const nextDrafts: Record<string, string> = {};
        for (const entry of entriesResult.value.entries) {
          nextDrafts[entry.family] = String(entry.priceUSD);
        }
        setDrafts(nextDrafts);
      } else if (operator) {
        setEntries(null);
        if (entriesResult.status === "rejected") {
          setLoadError(loadMessage(statusOf(entriesResult.reason)));
        }
      } else {
        // Non-operator: no values, no edit controls. The prices
        // read refusal is expected, not an error to surface.
        setEntries(null);
      }
    } catch {
      setEntries(null);
      setLoadError(loadMessage(0));
      setIsOperator(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError(loadMessage(0));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const savePrice = useCallback(
    async (family: PriceFamily) => {
      const price = Number(drafts[family] ?? "");
      if (!Number.isFinite(price) || price <= 0) {
        setActionError("The price is invalid: enter a positive amount in USD.");
        return;
      }
      setSavingFamily(family);
      setActionError(null);
      try {
        await setPrice(family, price);
        const fresh = await getPriceEntries();
        setEntries(fresh.entries);
        const nextDrafts: Record<string, string> = {};
        for (const entry of fresh.entries) {
          nextDrafts[entry.family] = String(entry.priceUSD);
        }
        setDrafts(nextDrafts);
      } catch (err) {
        setActionError(actionMessage(statusOf(err)));
      } finally {
        setSavingFamily(null);
      }
    },
    [drafts],
  );

  const approve = useCallback(async (family: PriceFamily) => {
    setApprovingFamily(family);
    setActionError(null);
    try {
      await approvePrice(family);
      const fresh = await getPriceEntries();
      setEntries(fresh.entries);
      const nextDrafts: Record<string, string> = {};
      for (const entry of fresh.entries) {
        nextDrafts[entry.family] = String(entry.priceUSD);
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setApprovingFamily(null);
    }
  }, []);

  // Issue #4691 — the section title lives in the PageShell: under the
  // Product Hub tab host it collapses to content-only (the tab label
  // is the title); standalone it renders as the page h1.
  return (
    <PageShell title="Per-run prices">
      <Card>
      {loading && <p>Loading per-run prices</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && !isOperator && (
        <p>Only a store operator can view or change per-run prices.</p>
      )}
      {!loading && !loadError && isOperator && entries && (
        <>
          <p>
            Per-run prices for the four families, plus the three premium
            services (options-scan, market-research, stock-signals),
            each priced per call. A price edit lands as Proposed and is
            not chargeable until an operator approves it; approval
            records the approving operator.
          </p>
          {entries.length === 0 && <p>No prices yet.</p>}
          {entries.map((entry) => (
            <div key={entry.id}>
              <p>
                {entry.family} — {formatUSD(entry.priceUSD)}{" "}
                {isPremiumPriceFamily(entry.family) ? "per call" : "per run"}
                (version {entry.version}, {entry.segment})
              </p>
              <p>{approvalLabel(entry)}</p>
              <TextInput
                label={`Price for ${entry.family} (USD)`}
                type="number"
                value={drafts[entry.family] ?? ""}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [entry.family]: e.target.value }))
                }
              />
              <Button
                variant="secondary"
                loading={savingFamily === entry.family}
                onClick={() => savePrice(entry.family)}
              >
                Save price
              </Button>
              {entry.approvalStatus === "proposed" && (
                <Button
                  variant="secondary"
                  loading={approvingFamily === entry.family}
                  onClick={() => approve(entry.family)}
                >
                  Approve price
                </Button>
              )}
            </div>
          ))}
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>
            Changing a price never affects a run already charged; the next
            run reads the stored catalogue price.
          </p>
        </>
      )}
    </Card>
    </PageShell>
  );
}
