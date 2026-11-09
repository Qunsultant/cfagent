import React from "react";
import { useMarketStatus } from "../marketClock";

export interface MarketStatusPillProps {
  className?: string;
  variant?: "pill" | "sub-header";
}

/**
 * Reusable real-time Market Status Indicator.
 * Automatically displays "Market OPEN · closes 16:00 ET" with a green pulsing dot during regular trading hours,
 * or the corresponding Pre-Market / After Hours / Closed status when outside market hours.
 */
export function MarketStatusPill({ className = "", variant = "sub-header" }: MarketStatusPillProps) {
  const status = useMarketStatus();
  const baseClass = variant === "pill" ? "pill-market-status" : "sub-header-market-pill";
  const statusClass = status.isOpen ? "open" : "closed";

  return (
    <div
      className={`${baseClass} top-nav-control ${statusClass} ${className}`.trim()}
      title={
        status.isOpen
          ? `US Equity Markets are OPEN (${status.easternTimeFormatted}). Regular Trading Hours are 09:30 - 16:00 ET.`
          : `US Equity Markets are CLOSED (${status.easternTimeFormatted}).`
      }
      role="status"
      aria-live="polite"
    >
      <span className={`market-dot ${status.dotClass}`} aria-hidden="true" />
      <span>{status.text}</span>
    </div>
  );
}
