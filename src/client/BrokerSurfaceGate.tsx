import React from "react";
import { Notice } from "./components/ui";
import { BROKER_CATALOG, type BrokerId } from "../trading";
import { panelAvailability, SURFACE_LABELS, type BrokerPanelSurface } from "../trading";

export interface BrokerSurfaceGateProps {
  /** The broker the user selected — never a default. */
  broker: BrokerId;
  surface: BrokerPanelSurface;
  /** The broker's own surface. Rendered only when the contract allows it. */
  children: React.ReactNode;
}

/**
 * Issue #2853: the one place a broker surface is allowed or refused.
 *
 * The panel contract (`src/trading/brokerPanels.ts`) decides; this component
 * only renders the decision. When the broker cannot provide the surface the
 * user gets a coded, named notice — never an empty panel, never another
 * broker's data rendered under this broker's name.
 *
 * Token-only styling: the notice is a `ui/` primitive, no colours here.
 */
export function BrokerSurfaceGate({ broker, surface, children }: BrokerSurfaceGateProps) {
  const availability = panelAvailability(broker, surface);
  if (availability.available) return <>{children}</>;

  return (
    <div data-broker-surface={surface} data-broker={broker} data-code={availability.code ?? ""}>
      <Notice tone="warning" title={`${SURFACE_LABELS[surface]} unavailable on ${BROKER_CATALOG[broker].label}`}>
        {availability.message}
      </Notice>
    </div>
  );
}
