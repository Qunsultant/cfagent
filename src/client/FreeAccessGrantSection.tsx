/**
 * Issue #3247 (slice 2 of #3241) — free-access grant section
 * for the Accounts admin panel (Platform Admin -> Accounts).
 *
 * Operator-only: grant, view, and revoke the account-level
 * free-access record for the looked-up account. The grant is
 * access only — sign-in, browse, and view stay free, with no
 * subscription fee for access, until the grant expires or is
 * revoked. It confers no tier and no included runs, and it
 * never makes a run free: activity still goes through the
 * normal gate. Nothing is granted by default — an operator
 * grants explicitly, with a reason; the server records the
 * session-verified operator login as grantedBy.
 *
 * This section reads and writes through the free-access routes
 * (GET /payments/agentic/commercial/free-access?userId=,
 * POST .../free-access/grant, POST .../free-access/revoke).
 * Granting while an active grant exists replaces it: the old
 * row is revoked and kept in history, and the new row is
 * granted. A revoke with no active grant answers 404 — a
 * stale UI — and the section re-reads. A 403 from those
 * routes means the server refused, never a client bug.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Select, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";

export interface FreeAccessGrantView {
  id: string;
  login: string;
  kind: "lifetime" | "limited";
  grantedBy: string;
  grantedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  reason: string;
}

interface FreeAccessGrantsResponse {
  userId: string;
  active: FreeAccessGrantView | null;
  history: FreeAccessGrantView[];
}

function isGrantView(value: unknown): value is FreeAccessGrantView {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant.id === "string" &&
    typeof grant.login === "string" &&
    (grant.kind === "lifetime" || grant.kind === "limited") &&
    typeof grant.grantedBy === "string" &&
    typeof grant.grantedAtMs === "number" &&
    (grant.expiresAtMs === null || typeof grant.expiresAtMs === "number") &&
    (grant.revokedAtMs === null || typeof grant.revokedAtMs === "number") &&
    typeof grant.reason === "string"
  );
}

function isGrantsResponse(value: unknown): value is FreeAccessGrantsResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.userId === "string" &&
    (response.active === null || isGrantView(response.active)) &&
    Array.isArray(response.history) &&
    response.history.every((row: unknown) => isGrantView(row))
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function fmtDate(ms: number | null): string {
  if (ms === null || ms === undefined) return "No expiry";
  return new Date(ms).toLocaleString();
}

function grantStatus(grant: FreeAccessGrantView | null, nowMs: number): string {
  if (!grant) return "No free-access grant on this account.";
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return `Grant EXPIRED ${fmtDate(grant.expiresAtMs)} — the access record has lapsed.`;
  }
  if (grant.kind === "lifetime") {
    return "Grant ACTIVE — free access for life, until revoked.";
  }
  return `Grant ACTIVE — free access until ${fmtDate(grant.expiresAtMs)}.`;
}

function historyLine(grant: FreeAccessGrantView, nowMs: number): string {
  const window =
    grant.kind === "lifetime"
      ? "lifetime, no expiry"
      : `limited, until ${fmtDate(grant.expiresAtMs)}`;
  if (grant.revokedAtMs !== null) {
    return `${grant.kind === "lifetime" ? "Lifetime" : "Limited"} (${window}) — revoked ${fmtDate(grant.revokedAtMs)}.`;
  }
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return `${grant.kind === "lifetime" ? "Lifetime" : "Limited"} (${window}) — expired.`;
  }
  return `${grant.kind === "lifetime" ? "Lifetime" : "Limited"} (${window}) — active.`;
}

export function FreeAccessGrantSection({ userId }: { userId: string }) {
  const [active, setActive] = useState<FreeAccessGrantView | null>(null);
  const [history, setHistory] = useState<FreeAccessGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"lifetime" | "limited">("lifetime");
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [mutating, setMutating] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(
        `/api/payments/agentic/commercial/free-access?userId=${encodeURIComponent(userId)}`,
      );
      const data = await readJson(res);
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Operator access required: only store operators may manage grants."
            : (data.error as string) || "Could not load the free-access grant.",
        );
        setActive(null);
        setHistory([]);
        return;
      }
      if (!isGrantsResponse(data)) {
        setError("Unexpected free-access response from the server.");
        setActive(null);
        setHistory([]);
        return;
      }
      setActive(data.active);
      setHistory(data.history);
    } catch {
      setError("Could not load the free-access grant.");
      setActive(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runGrant = useCallback(async () => {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setNote("Enter a reason for the grant.");
      return;
    }
    let expiresAtMs: number | null = null;
    if (kind === "limited") {
      if (expiry.trim() === "") {
        setNote("Enter an expiry date for a limited grant.");
        return;
      }
      const parsed = Date.parse(expiry.trim());
      if (!Number.isFinite(parsed) || parsed <= Date.now()) {
        setNote("Expiry must be a future date (e.g. 2027-01-01).");
        return;
      }
      expiresAtMs = parsed;
    }
    setMutating(true);
    setNote("");
    try {
      const res = await apiFetch("/api/payments/agentic/commercial/free-access/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, kind, expiresAtMs, reason: trimmedReason }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setNote((data.error as string) || "Grant failed.");
        return;
      }
      setNote(
        kind === "lifetime"
          ? "Free-access grant set. Access stays free for this account until the grant is revoked."
          : "Free-access grant set. Access stays free for this account until the grant expires or is revoked.",
      );
      setReason("");
      setExpiry("");
      await load();
    } catch {
      setNote("Grant failed.");
    } finally {
      setMutating(false);
    }
  }, [reason, kind, expiry, userId, load]);

  const runRevoke = useCallback(async () => {
    setMutating(true);
    setNote("");
    try {
      const res = await apiFetch("/api/payments/agentic/commercial/free-access/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        if (res.status === 404) {
          setNote("The grant is already gone — reloaded.");
          await load();
          return;
        }
        setNote((data.error as string) || "Revoke failed.");
        return;
      }
      setNote("Free-access grant revoked.");
      await load();
    } catch {
      setNote("Revoke failed.");
    } finally {
      setMutating(false);
    }
  }, [userId, load]);

  if (loading) return null;
  if (error) return <Notice tone="danger">{error}</Notice>;

  const pastGrants = history.filter((row) => row.id !== active?.id);
  return (
    <Stack gap="1">
      <h4>Free-access grant (operator)</h4>
      <p>
        Free access for this account: sign-in, browse, and view stay
        free, with no subscription fee for access, until the grant
        expires or is revoked. A grant covers access only —
        activity is still charged through the normal gate. No
        account is granted by default.
      </p>
      <div>
        <strong>Status:</strong> {grantStatus(active, Date.now())}
      </div>
      {active && (
        <div>
          <strong>Granted by:</strong> {active.grantedBy}
          <br />
          <strong>Reason:</strong> {active.reason}
          <br />
          <strong>Granted:</strong> {fmtDate(active.grantedAtMs)}
          <br />
          <strong>Expires:</strong> {fmtDate(active.expiresAtMs)}
        </div>
      )}
      {pastGrants.length > 0 && (
        <div>
          <strong>History:</strong>
          {pastGrants.map((row) => (
            <div key={row.id}>{historyLine(row, Date.now())}</div>
          ))}
        </div>
      )}
      {active && (
        <p>
          Granting replaces the current grant — the current grant is
          revoked and kept in history.
        </p>
      )}
      <Select
        label="Grant kind"
        value={kind}
        onChange={(event) => setKind(event.target.value as "lifetime" | "limited")}
      >
        <option value="lifetime">Lifetime</option>
        <option value="limited">Limited time</option>
      </Select>
      {kind === "limited" && (
        <TextInput
          label="Expiry (e.g. 2027-01-01 — must be a future date)"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
        />
      )}
      <TextInput
        label="Reason for the grant"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div>
        <Button onClick={() => void runGrant()} loading={mutating}>
          Grant free access
        </Button>
      </div>
      {active && (
        <div>
          <Button onClick={() => void runRevoke()} loading={mutating}>
            Revoke grant
          </Button>
        </div>
      )}
      {note && <Notice tone="info">{note}</Notice>}
    </Stack>
  );
}
