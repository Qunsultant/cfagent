/**
 * Issue #1324: pending-review queue for #277-held deliveries, surfaced
 * in the Reports panel — the surface the F2 held announcement points
 * operators to ("Approve it in the Reports panel's pending-review list").
 *
 * Each held delivery shows its detail, artifact file names (never payload
 * bytes — the list endpoint returns summaries only), a countdown to
 * expiry, and two actions: Approve dispatches the held delivery via
 * POST /trading/reports/confirm, Let expire rejects it (discarded
 * unsent). Expired rows never appear: the list endpoint marks them
 * expired before returning.
 *
 * Compliance (docs/architecture/UX/ux-architecture.md): built only from
 * src/client/components/ui/ primitives on semantic tokens; status is
 * never carried by color alone (the countdown text is always present);
 * server state is authoritative (the list refreshes after every action);
 * failures render a business error notice, never a technical message.
 */

import { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Badge, Button, Card, EmptyState, Modal, Notice, Spinner } from "./components/ui";

export interface PendingReviewItem {
  confirmationId: string;
  kind: string;
  createdAt: string;
  expiresAt: string | null;
  detail: string;
  artifacts: string[];
  channel?: string;
  displayName?: string;
  reportUrl?: string;
}

/** Pure countdown label: exact hours+minutes, "Expired" past expiry,
 *  "Expiry unknown" when the server gives no usable timestamp. */
export function formatCountdown(expiresAt: string | null, nowMs: number): string {
  if (!expiresAt) return "Expiry unknown";
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(ms)) return "Expiry unknown";
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `expires in ${hours}h ${mins % 60}m`;
  return `expires in ${mins}m`;
}

function msUntilExpiry(expiresAt: string | null, nowMs: number): number {
  if (!expiresAt) return Number.POSITIVE_INFINITY;
  const ms = new Date(expiresAt).getTime() - nowMs;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function PendingReviewQueue() {
  const [items, setItems] = useState<PendingReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/reports/pending", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setError("Could not load the pending-review queue.");
        return;
      }
      const data = (await res.json()) as { pending?: unknown };
      setItems(Array.isArray(data.pending) ? (data.pending as PendingReviewItem[]) : []);
      setError(null);
    } catch {
      setError("Could not load the pending-review queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-render the countdowns without refetching; the server remains
  // authoritative (actions and manual refresh re-read the list).
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  type DecideTarget = { id: string; decision: "approved" | "rejected"; detail: string };
  const [decideTarget, setDecideTarget] = useState<DecideTarget | null>(null);

  const decide = async (confirmationId: string, decision: "approved" | "rejected") => {    setActingId(confirmationId);
    setError(null);
    try {
      const res = await fetch("/api/trading/reports/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationId, decision }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(
          typeof data?.error === "string"
            ? data.error
            : decision === "approved"
              ? "Approval failed. The delivery was not sent."
              : "Could not release the delivery. It is still held."
        );
        return;
      }
      await refresh();
    } catch {
      setError(
        decision === "approved"
          ? "Approval failed. The delivery was not sent."
          : "Could not release the delivery. It is still held."
      );
    } finally {
      setActingId(null);
    }
  };

  return (
    <section className="pending-review-queue" aria-label="Pending review">
      <Modal
        open={decideTarget !== null}
        onClose={() => setDecideTarget(null)}
        title={decideTarget?.decision === "approved" ? "Approve held delivery?" : "Let delivery expire?"}
        footer={
          <>
            <Button
              type="button"
              variant={decideTarget?.decision === "approved" ? "primary" : "danger"}
              onClick={() => {
                const target = decideTarget;
                setDecideTarget(null);
                if (target) void decide(target.id, target.decision);
              }}
            >
              {decideTarget?.decision === "approved" ? "Approve and send" : "Let expire"}
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setDecideTarget(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          {decideTarget?.decision === "approved"
            ? "Send this held delivery now?"
            : "Discard this held delivery unsent?"}{" "}
          {decideTarget?.detail}
        </p>
      </Modal>
      <div className="pending-review-header">
        <h3>Pending review</h3>
        <Badge tone="neutral" size="sm">
          {items.length} held
        </Badge>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </div>
      {error && (
        <Notice tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {loading ? (
        <Spinner label="Loading held deliveries" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No deliveries awaiting review"
          description="Held deliveries appear here with their expiry countdown. Approve to send, or let expire to discard unsent."
        />
      ) : (
        <div className="pending-review-list">
          {items.map((item) => {
            const countdown = formatCountdown(item.expiresAt, nowMs);
            const urgent = msUntilExpiry(item.expiresAt, nowMs) < 60 * 60 * 1000;
            const acting = actingId === item.confirmationId;
            return (
              <Card key={item.confirmationId}>
                <div className="pending-review-item-header">
                  <Badge tone={item.kind === "screener" ? "accent" : "neutral"} size="sm" dot>
                    {item.kind}
                  </Badge>
                  <Badge tone={urgent ? "warning" : "neutral"} size="sm">
                    {countdown}
                  </Badge>
                </div>
                <p className="pending-review-detail">{item.detail}</p>
                {item.artifacts.length > 0 && (
                  <ul className="pending-review-artifacts">
                    {item.artifacts.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                )}
                {item.reportUrl && (
                  <a className="pending-review-report-link" href={item.reportUrl} download>
                    📄 Report
                  </a>
                )}
                <div className="pending-review-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={acting}
                    onClick={() =>
                      setDecideTarget({ id: item.confirmationId, decision: "approved", detail: item.detail })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={acting}
                    onClick={() =>
                      setDecideTarget({ id: item.confirmationId, decision: "rejected", detail: item.detail })
                    }
                  >
                    Let expire
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
