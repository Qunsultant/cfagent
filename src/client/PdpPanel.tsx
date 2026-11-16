/**
 * Issue #4651 — the SecHub PDP tab panel: the Policy Decision Point's
 * live state, read-only.
 *
 * Reads live state only, from two real sources:
 * - GET /api/iaaa/policy-proposals/active (existing, #2838) for the
 *   active policy snapshot and its source (compiled vs pap-promoted).
 * - GET /api/security/pdp (new, this slice) for the resolved policy
 *   source (IAAA_PDP_POLICY_SOURCE code|snapshot + invalid flag), the
 *   frozen OBLIGATION_POLICY entries, and their live
 *   evaluateWithObligations() coverage.
 *
 * Honest empty states: a value with no readable source renders as
 * "not available", never invented. No edit control exists here —
 * policy is edited through the PAP proposals flow, and
 * OBLIGATION_POLICY is frozen (edit scope undecided, #2838 carry).
 *
 * Composed from ui/ primitives (ADR-0004): Stack for layout, Spinner
 * for loading, Notice for the fail-closed warning, EmptyState for
 * honest empty states. No bespoke className tokens, no inline
 * styles, no CSS imports.
 */
import { useEffect, useState } from "react";
import { CardHeader, EmptyState, Notice, Spinner, Stack } from "./components/ui";
import { fetchActivePolicy, type PolicySnapshotInfo } from "./policyProposalsApi";
import { fetchPdpState, type PdpState } from "./pdpApi";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      active: PolicySnapshotInfo;
      activeSource: string;
      pdp: PdpState;
    };

export function PdpPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchActivePolicy(), fetchPdpState()])
      .then(([activeResult, pdp]) => {
        if (cancelled) return;
        setState({
          status: "ready",
          active: activeResult.active,
          activeSource: activeResult.source,
          pdp,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load PDP state.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Stack>
        <Spinner label="Loading policy state" />
        <p>Loading policy state…</p>
      </Stack>
    );
  }

  if (state.status === "error") {
    const forbidden = /forbidden/i.test(state.message);
    return (
      <EmptyState
        title={
          forbidden
            ? "Policy state is available to platform admins only."
            : "The Policy Decision Point state could not be loaded."
        }
        description={state.message}
      />
    );
  }

  const { active, activeSource, pdp } = state;
  const roles = Object.keys(active.roleGrants);
  const coverageByPermission = new Map(
    pdp.coverage.map((entry) => [entry.permission, entry]),
  );

  return (
    <Stack gap="2">
      <div>
        <CardHeader title="Active policy" />
        <p>Version: {active.version}</p>
        <p>Source: {activeSource}</p>
        {roles.length === 0 ? (
          <EmptyState title="No role grants in the active policy." />
        ) : (
          <ul>
            {roles.map((role) => (
              <li key={role}>
                {role}:{" "}
                {active.roleGrants[role].length === 0
                  ? "no permissions"
                  : active.roleGrants[role].join(", ")}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <CardHeader title="Policy source" />
        <p>Resolved source: {pdp.policySource.source}</p>
        {pdp.policySource.invalid ? (
          <Notice tone="warning">
            Warning: the platform policy switch is invalid — the PDP has failed
            closed to the compiled policy. Check IAAA_PDP_POLICY_SOURCE and
            IAAA_PDP_POLICY_SNAPSHOT_JSON.
          </Notice>
        ) : (
          <p>
            The platform policy switch is valid; the PDP decides from the{" "}
            {pdp.policySource.source === "snapshot" ? "promoted snapshot" : "compiled policy"}.
          </p>
        )}
      </div>

      <div>
        <CardHeader title="Obligations" />
        <p>
          Read-only: obligations attach to permissions in the frozen obligation
          policy and cannot be edited on this tab.
        </p>
        {pdp.obligations.length === 0 ? (
          <EmptyState title="No obligations are declared." />
        ) : (
          <ul>
            {pdp.obligations.map((entry) => {
              const coverage = coverageByPermission.get(entry.permission);
              return (
                <li key={entry.permission}>
                  <p>{entry.permission}</p>
                  <p>
                    Obligations:{" "}
                    {entry.obligations.length === 0
                      ? "none"
                      : entry.obligations.join(", ")}
                  </p>
                  {entry.advice.map((a) => (
                    <p key={a.kind}>{a.message}</p>
                  ))}
                  {coverage ? (
                    <p>
                      Coverage: {coverage.status}
                      {coverage.status === "enforced" &&
                      coverage.enforcementPoints.length > 0
                        ? ` — enforced on ${coverage.enforcementPoints.join(", ")}`
                        : ""}
                      {coverage.status === "residual"
                        ? " — the policy entry exists but no live enforcement point uses it yet"
                        : ""}
                    </p>
                  ) : (
                    <p>Coverage: not reported for this permission.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Stack>
  );
}
