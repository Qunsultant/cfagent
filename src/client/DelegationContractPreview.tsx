/**
 * Delegation Contract preview (Qunsultant/cfagent#1773, item 4;
 * HAX #1 scope disclosure). Renders a DelegationContract built by
 * src/client/delegationContract.ts. No inline styles and no raw
 * controls: the #2177 bespoke-styling ceiling counts every
 * inline-style prop, so this component leans on the Card
 * primitive's own padding and browser defaults instead of adding
 * any (the #1580 freeze/density gates scan this file too).
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
        <h4>{title}</h4>
        {SECTIONS.map(([label, key]) => (
          <div key={key}>
            <strong>{label}</strong>
            <ul>
              {contract[key].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </section>
  );
}
