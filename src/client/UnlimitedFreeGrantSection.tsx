/**
 * Issue #3245 (slice 1 of #3241) — unlimited-free grant section
 * for the Accounts admin panel (Platform Admin -> Accounts).
 *
 * Operator-only: grant, view, and revoke the account-level
 * unlimited-free entitlement for the looked-up account. The grant
 * covers every screener family, manual or scheduled (including
 * recurring runs), free and unlimited, until it expires or is
 * revoked. Nothing is granted by default — an operator grants
 * explicitly, with a reason; the server records the
 * session-verified operator login as grantedBy.
 *
 * This section reads and writes through the EXISTING operator-gated
 * commercial account routes (GET + POST
 * /payments/agentic/commercial/account); it invents no new path.
 * The POST re-sends the account's current tier/credits/included-runs
 * from the GET record so a grant write preserves them (the upsert
 * defaults omitted numbers to zero). A 403 from those routes means
 * the server refused, never a client bug.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";

import { commercialPath } from "../data/commercialUrlCatalog";
export interface UnlimitedFreeGrantView {
  grantedBy: string;
  reason: string;
  expiresAtMs: number | null;
}

interface CommercialAccountRecordView {
  id: string;
  tenantId: string;
  tier: string;
  creditsUSD: number;
  includedRuns: number;
  unlimitedFreeGrant?: UnlimitedFreeGrantView | null;
}

function isGrantView(value: unknown): value is UnlimitedFreeGrantView {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant.grantedBy === "string" &&
    typeof grant.reason === "string" &&
    (grant.expiresAtMs === null || typeof grant.expiresAtMs === "number")
  );
}

function isAccountRecord(value: unknown): value is CommercialAccountRecordView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.tenantId === "string" &&
    typeof record.tier === "string" &&
    typeof record.creditsUSD === "number" &&
    typeof record.includedRuns === "number" &&
    (record.unlimitedFreeGrant === undefined ||
      record.unlimitedFreeGrant === null ||
      isGrantView(record.unlimitedFreeGrant))
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function fmtDate(ms: number | null): string {
  if (ms === null || ms === undefined) return "No expiry";
  return new Date(ms).toLocaleString();
}

function grantStatus(grant: UnlimitedFreeGrantView | null, nowMs: number): string {
  if (!grant) return "No unlimited-free grant on this account.";
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return `Grant EXPIRED ${fmtDate(grant.expiresAtMs)} — the normal gate applies again.`;
  }
  return `Grant ACTIVE — unlimited free runs until ${fmtDate(grant.expiresAtMs)}.`;
}

export function UnlimitedFreeGrantSection({ userId }: { userId: string }) {
  const [record, setRecord] = useState<CommercialAccountRecordView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState("");
  const [mutating, setMutating] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(
        `${commercialPath("account")}?userId=${encodeURIComponent(userId)}`,
      );
      const data = await readJson(res);
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Operator access required: only store operators may manage grants."
            : (data.error as string) || "Could not load the account.",
        );
        setRecord(null);
        return;
      }
      if (!isAccountRecord(data.record)) {
        setError("Unexpected account response from the server.");
        setRecord(null);
        return;
      }
      setRecord(data.record);
    } catch {
      setError("Could not load the account.");
      setRecord(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const postGrant = useCallback(
    async (grant: UnlimitedFreeGrantView | null) => {
      if (!record) return;
      setMutating(true);
      setNote("");
      try {
        const res = await apiFetch(commercialPath("account"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: record.id,
            tenantId: record.tenantId,
            tier: record.tier,
            creditsUSD: record.creditsUSD,
            includedRuns: record.includedRuns,
            unlimitedFreeGrant: grant,
          }),
        });
        const data = await readJson(res);
        if (!res.ok) {
          setNote(data.error as string || "Grant update failed.");
          return;
        }
        setNote(
          grant === null
            ? "Unlimited-free grant revoked. The normal gate applies again."
            : "Unlimited-free grant set. The account now runs any screen free, unlimited.",
        );
        setReason("");
        setExpiry("");
        await load();
      } catch {
        setNote("Grant update failed.");
      } finally {
        setMutating(false);
      }
    },
    [record, load],
  );

  const runGrant = useCallback(() => {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setNote("Enter a reason for the grant.");
      return;
    }
    let expiresAtMs: number | null = null;
    if (expiry.trim() !== "") {
      const parsed = Date.parse(expiry.trim());
      if (!Number.isFinite(parsed) || parsed <= Date.now()) {
        setNote("Expiry must be a future date (e.g. 2027-01-01). Leave it blank for no expiry.");
        return;
      }
      expiresAtMs = parsed;
    }
    // grantedBy is set server-side from the operator's session;
    // the placeholder here is never trusted (the route overwrites it).
    void postGrant({ grantedBy: "", reason: trimmedReason, expiresAtMs });
  }, [reason, expiry, postGrant]);

  if (loading) return null;
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!record) return null;

  const grant = record.unlimitedFreeGrant ?? null;
  return (
    <Stack gap="1">
      <h4>Unlimited-free grant (operator)</h4>
      <p>
        An approved account runs any screen — stock, options, goal,
        strategy, manual or scheduled — free and unlimited, with no
        checkout and no credit or included-run deduction, until the
        grant expires or is revoked. No account is granted by default.
      </p>
      <div>
        <strong>Status:</strong> {grantStatus(grant, Date.now())}
      </div>
      {grant && (
        <div>
          <strong>Granted by:</strong> {grant.grantedBy}
          <br />
          <strong>Reason:</strong> {grant.reason}
          <br />
          <strong>Expires:</strong> {fmtDate(grant.expiresAtMs)}
        </div>
      )}
      <TextInput
        label="Reason for the grant"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <TextInput
        label="Expiry (optional, e.g. 2027-01-01 — blank means no expiry)"
        value={expiry}
        onChange={(event) => setExpiry(event.target.value)}
      />
      <div>
        <Button onClick={runGrant} loading={mutating}>
          Grant unlimited free
        </Button>
      </div>
      {grant && (
        <div>
          <Button onClick={() => void postGrant(null)} loading={mutating}>
            Revoke grant
          </Button>
        </div>
      )}
      {note && <Notice tone="info">{note}</Notice>}
    </Stack>
  );
}
