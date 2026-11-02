/**
 * Confidence method breakdown (Qunsultant/cfagent#1773, item 5;
 * HAX #9 uncertainty). Renders the rows from
 * src/client/options/confidenceMethod.ts beside a best-trade
 * confidence rating, inside a Card ui primitive with no inline
 * styles (the #2177 bespoke-styling ceiling counts every
 * inline-style prop) and no raw controls (the #1580
 * freeze/density gates scan this file).
 */
import React from "react";
import { Card } from "../components/ui";
import { confidenceMethodRows, type ConfidenceMethodInput } from "./confidenceMethod";

export function ConfidenceMethodBreakdown({ pick }: { pick: ConfidenceMethodInput }) {
  const rows = confidenceMethodRows(pick);
  return (
    <Card padding="sm">
      <details>
        <summary>
          How this confidence rating was computed
        </summary>
        <ul>
          {rows.map((row) => (
            <li key={row.label}>
              <strong>{row.label}:</strong> {row.value}
              {row.verdict === "pass" ? " — met" : row.verdict === "fail" ? " — not met" : ""}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
