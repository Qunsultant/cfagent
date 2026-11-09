/**
 * Issue 2973 (nav re-org slice 5): the dead-letter queue surface.
 *
 * The DLQ had API routes but no client UI; this panel is its first
 * surface. Listing and replay stay operator-gated on the server
 * (403 when the login is not a store operator); this panel renders
 * that gate as a notice, never as a crash, and never weakens it.
 * Failures render a business-worded notice, never a technical
 * message. Built only from src/client/components/ui/ primitives.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Notice, Spinner } from "./components/ui";
import { csrfHeaders } from "./apiFetch";

/** Store row shape, mirroring the server's DeadLetterStoreRecord. */
interface DlqRecord {
  id: string;
  queue: string;
  reason: string;
  messageId: string | null;
  runId: string | null;
  unitId: string | null;
  actorLogin: string | null;
  subscriber: string | null;
  detail: string | null;
  createdAtMs: number;
}

/** Issue #3907: the header text, as a pure function — loading /
 *  load-failed / empty / N records are distinct states; a failed
 *  load never reads as "Queue clear" (the 2026-11-09 incident:
 *  the panel showed "Queue clear" alongside "could not be
 *  loaded"). */
export function dlqHeaderStatus(args: { loading: boolean; error: string | null; count: number }): string {
  if (args.loading) return "Loading…";
  if (args.error) return "Could not load";
  if (args.count === 0) return "Queue clear";
  return `${args.count} unreplayed record${args.count === 1 ? "" : "s"}`;
}

export function DlqPanel() {
  const [records, setRecords] = useState<DlqRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [gated, setGated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await globalThis.fetch("/api/ops/dlq/records");
      if (response.status === 403) {
        setGated(true);
        setRecords([]);
        return;
      }
      const data = (await response.json().catch(() => null)) as {
        records?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        throw new Error(
          typeof data?.error === "string" && data.error
            ? data.error
            : "The dead-letter queue could not be loaded.",
        );
      }
      setGated(false);
      setRecords(Array.isArray(data?.records) ? (data.records as DlqRecord[]) : []);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The dead-letter queue could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const replay = useCallback(
    async (recordId: string) => {
      setReplayingId(recordId);
      setError(null);
      setNotice(null);
      try {
        const response = await globalThis.fetch("/api/ops/dlq/replay", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
          body: JSON.stringify({ recordId }),
        });
        const data = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        if (response.status === 403) {
          setGated(true);
          return;
        }
        if (!response.ok) {
          throw new Error(
            typeof data?.error === "string" && data.error
              ? data.error
              : "That record could not be replayed.",
          );
        }
        setNotice("Record replayed to its source queue.");
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "That record could not be replayed.",
        );
      } finally {
        setReplayingId(null);
      }
    },
    [refresh],
  );

  if (loading) {
    return <Spinner />;
  }

  if (gated) {
    return (
      <Notice tone="neutral" title="Operator access required">
        The dead-letter queue is operator-gated: listing and replay need
        store operator access for this login. Nothing below is hidden
        from you — the server declines the listing itself.
      </Notice>
    );
  }

  return (
    <div className="dlq-panel">
      <div className="dlq-panel-head">
        <span role="status">
          {dlqHeaderStatus({ loading: false, error, count: records.length })}
        </span>
        <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      {error && (
        <Notice tone="danger" density="compact" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" density="compact" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}

      {records.length === 0 ? (
        error ? null : (
          <EmptyState
            title="No unreplayed records"
            description="The dead-letter queue is clear: nothing is waiting for a replay."
          />
        )
      ) : (
        <ul className="dlq-record-list">
          {records.map((record) => (
            <li key={record.id} className="dlq-record-item">
              <div className="dlq-record-main">
                <Badge tone="warning">{record.reason}</Badge>
                <strong>{record.queue}</strong>
                <small>
                  {new Date(record.createdAtMs).toLocaleString()}
                  {record.messageId ? ` · message ${record.messageId}` : ""}
                  {record.runId ? ` · run ${record.runId}` : ""}
                  {record.unitId ? ` · unit ${record.unitId}` : ""}
                  {record.subscriber ? ` · subscriber ${record.subscriber}` : ""}
                </small>
                {record.detail && <p>{record.detail}</p>}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={replayingId === record.id}
                loading={replayingId === record.id}
                onClick={() => void replay(record.id)}
              >
                Replay
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
