import React, { useState } from "react";
import { Button } from "./components/ui";

/**
 * Issue #6473 — the report's shareable link.
 *
 * The PDF is addressable, so the panel shows the link itself (openable and
 * copyable) and a Share button rather than a download-only affordance. Web
 * Share is used where the platform has it; the clipboard is the fallback
 * because it always works on desktop. The URL is rendered in text as well, so
 * a browser with neither still lets the reader take the link.
 */
export function ReportLinkRow({ url }: { url: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const share = async () => {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ url, title: "Opportunity Hunt report" });
        setMessage("Shared.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setMessage("Report link copied.");
    } catch {
      setMessage("Copy the link from the line below.");
    }
  };
  return (
    <div className="ui-stack">
      <div className="ui-row">
        <a href={url} target="_blank" rel="noreferrer">
          Open report
        </a>
        <Button variant="secondary" size="sm" onClick={() => void share()}>
          Share
        </Button>
      </div>
      <span className="ui-meta-sm">{url}</span>
      {message ? <span className="ui-meta-sm">{message}</span> : null}
    </div>
  );
}
