/**
 * Delegation Contract preview (Qunsultant/cfagent#1773, item 4;
 * HAX #1 scope disclosure). Renders a DelegationContract built by
 * src/client/delegationContract.ts. Token-only styling, no raw
 * controls (the #1580 freeze/density gates scan this file).
 */
import React from "react";
import { Card } from "./components/ui";
import type { DelegationContract } from "./delegationContract";

const SECTIONS: Array<[string, keyof DelegationContract]> = [
  ["What will be done", "willDo"],
  ["What will not be done", "willNotDo"],
  ["Which systems will be accessed", "systemsAccessed"],
  ["Which actions require approval", "approvalsRequired"],
  ["Budget and duration limits", "budgetAndDuration"],
  ["Expected outputs", "expectedOutputs"],
];

export function DelegationContractPreview({
  contract,
  title = "Delegation contract — what this goal authorizes",
}: {
  contract: DelegationContract;
  title?: string;
}) {
  return (
    <section aria-label="Delegation contract preview">
      <Card>
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <h4 style={{ margin: "0", fontSize: "var(--font-size-body)" }}>{title}</h4>
          {SECTIONS.map(([label, key]) => (
            <div key={key}>
              <strong style={{ fontSize: "var(--font-size-body-sm)" }}>{label}</strong>
              <ul style={{ margin: "0", paddingLeft: "var(--space-4)", fontSize: "var(--font-size-body-sm)" }}>
                {contract[key].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}
