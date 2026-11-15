/**
 * Issue #1325: Regenerate action for failed-PDF runs in Reports (and
 * ScreenersHub, which embeds ReportsPanel). Calls the shipped R5
 * endpoint POST /screener/report/regenerate — no re-screen — which
 * heals LATEST + its HISTORY entry, then fires onRegenerated so the
 * parent refreshes the run in place: the healed PDF link appears and
 * pdfError clears.
 *
 * Failure semantics (from the endpoint): a failed regeneration
 * surfaces the new coded error; 404 means no stored run exists.
 * Scope note: the endpoint regenerates the LATEST run. On the latest
 * failed row this heals the row in place (the acceptance case); on an
 * older failed row the refresh reveals the healed latest run instead.
 * The button text never claims more than the endpoint does.
 *
 * Compliance (docs/architecture/UX/ux-architecture.md): built only from
 * src/client/components/ui/ primitives; server state is authoritative
 * (the parent refresh re-reads the list); failures render a business
 * error notice, never a technical message.
 */

import { useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Button, Notice } from "./components/ui";

export interface RegeneratePdfButtonProps {
  /** Fired after a successful regeneration so the parent refreshes its list. */
  onRegenerated?: () => void;
}

export function RegeneratePdfButton({ onRegenerated }: RegeneratePdfButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/screener/report/regenerate", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => null)) as {
        pdfStatus?: unknown;
        pdfError?: unknown;
        error?: unknown;
      } | null;
      if (res.status === 404) {
        setError("No stored run to regenerate.");
        return;
      }
      if (!res.ok || data?.pdfStatus !== "generated") {
        setError(
          typeof data?.pdfError === "string" && data.pdfError
            ? data.pdfError
            : typeof data?.error === "string" && data.error
              ? data.error
              : "Regeneration failed. The PDF was not generated."
        );
        return;
      }
      onRegenerated?.();
    } catch {
      setError("Regeneration failed. The PDF was not generated.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="regenerate-pdf">
      <Button variant="secondary" size="sm" loading={loading} onClick={() => void regenerate()}>
        Regenerate
      </Button>
      {error && (
        <Notice tone="danger" density="compact" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
    </span>
  );
}
