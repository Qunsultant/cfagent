import React, { useCallback, useState } from "react";
import { Button, Flex, Modal, Notice, Stack } from "./components/ui";

/**
 * Issue #3885 — “cancel every open order”, with the two-step gate the issue
 * requires, on the Portfolio order-history surface.
 *
 * The button never cancels: it asks the server for a preview. The modal shows
 * exactly what the preview says (how many, which symbols, which classes, how
 * old the oldest is, when the token expires) and only the confirm button
 * presents the token. A refusal (over the cap, expired, partially failed) is
 * rendered with the server's own words, and the order table is refreshed only
 * after the server reports a completed cancel — never optimistically.
 *
 * Styling: `ui/` primitives only (Button / Modal / Notice / Stack / Flex);
 * no raw colors, no inline styles (ux-architecture §20).
 */

export interface CancelAllPreviewView {
  count: number;
  symbols: string[];
  classes: string[];
  oldest: string | null;
  newest: string | null;
  expiresAt: string;
}

export interface AlpacaCancelAllControlProps {
  /** How many OPEN rows the order-history table currently shows. */
  openOrders: number;
  /** Called after the server reports a completed cancel (refresh the table). */
  onCancelled: () => void;
}

function when(value: string | null): string {
  if (!value) return "not recorded";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function AlpacaCancelAllControl({ openOrders, onCancelled }: AlpacaCancelAllControlProps) {
  const [busy, setBusy] = useState<null | "preview" | "confirm">(null);
  const [preview, setPreview] = useState<CancelAllPreviewView | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"neutral" | "danger">("neutral");

  const requestPreview = useCallback(async () => {
    setBusy("preview");
    setMessage(null);
    try {
      const res = await fetch("/api/broker/orders/cancel-all", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        preview?: CancelAllPreviewView;
        previewToken?: string;
        message?: string;
        code?: string;
      };
      if (body.preview && body.previewToken) {
        setPreview(body.preview);
        setToken(body.previewToken);
        setMessage(null);
      } else {
        setTone("danger");
        setMessage(body.message ?? body.code ?? "The preview could not be produced, so nothing was cancelled.");
      }
    } catch {
      setTone("danger");
      setMessage("Alpaca could not be reached, so no preview was produced and nothing was cancelled.");
    } finally {
      setBusy(null);
    }
  }, []);

  const confirmCancellation = useCallback(async () => {
    if (!token) return;
    setBusy("confirm");
    try {
      const res = await fetch("/api/broker/orders/cancel-all", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirm: token }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setTone(res.ok ? "neutral" : "danger");
      setMessage(body.message ?? (res.ok ? "Every open order was cancelled." : "The broker did not cancel every open order."));
      if (res.ok) onCancelled();
    } catch {
      setTone("danger");
      setMessage("Alpaca could not be reached. Some orders may still be open.");
    } finally {
      setPreview(null);
      setToken(null);
      setBusy(null);
    }
  }, [onCancelled, token]);

  return (
    <Stack gap="2">
      <Flex align="center" gap="2">
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={openOrders === 0 || busy !== null}
          loading={busy === "preview"}
          onClick={() => void requestPreview()}
        >
          Cancel all open orders
        </Button>
      </Flex>

      {message && (
        <Notice tone={tone === "danger" ? "danger" : "neutral"} title="Cancel all">
          <span data-alpaca-cancel-all-message>{message}</span>
        </Notice>
      )}

      <Modal
        open={preview !== null}
        onClose={() => {
          setPreview(null);
          setToken(null);
        }}
        title="Cancel every open order?"
        size="md"
        footer={
          <Flex align="center" gap="2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy === "confirm"}
              onClick={() => {
                setPreview(null);
                setToken(null);
              }}
            >
              Keep my orders
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={busy === "confirm"}
              onClick={() => void confirmCancellation()}
            >
              Cancel {preview?.count ?? 0} orders
            </Button>
          </Flex>
        }
      >
        {preview && (
          <Stack gap="2">
            <p data-alpaca-cancel-all-count>
              {preview.count} open order{preview.count === 1 ? "" : "s"} would be cancelled. Nothing has been cancelled
              yet.
            </p>
            <p data-alpaca-cancel-all-symbols>Symbols: {preview.symbols.join(", ") || "not recorded"}</p>
            <p data-alpaca-cancel-all-classes>Classes: {preview.classes.join(", ") || "not recorded"}</p>
            <p data-alpaca-cancel-all-window>
              Oldest: {when(preview.oldest)} — newest: {when(preview.newest)}
            </p>
            <p data-alpaca-cancel-all-expiry>This confirmation expires at {when(preview.expiresAt)}.</p>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
