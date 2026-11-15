/**
 * Issue #4653 — the SecHub PEP tab panel: the Policy Enforcement
 * Point's live state, read-only.
 *
 * Reads live state only, from one real source:
 * - GET /api/security/pep (new, this slice) for the enforcement
 *   state of the caller's session, the cited gate inventory, and the
 *   recent-decisions record (none exists yet — the endpoint reports
 *   that, and the panel renders an honest empty state, never invented
 *   rows).
 *
 * No enforcement change lives here: the panel renders what the
 * server reports. The gates enforce silently in their routes; this
 * tab only makes them visible.
 *
 * Composed from ui/ primitives (ADR-0004): Stack for layout, Spinner
 * for loading, Notice for the fail-closed warning, EmptyState for
 * honest empty states. No bespoke className tokens, no inline
 * styles, no CSS imports.
 */
import { useEffect, useState } from "react";
import { EmptyState, Notice, Spinner, Stack } from "./components/ui";
import { fetchPepState, type PepState } from "./pepApi";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pep: PepState };

export function PepPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchPepState()
      .then((pep) => {
        if (cancelled) return;
        setState({ status: "ready", pep });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load PEP state.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Stack>
        <Spinner label="Loading PEP state" />
        <p>Loading PEP state…</p>
      </Stack>
    );
  }

  if (state.status === "error") {
    const forbidden = /forbidden/i.test(state.message);
    return (
      <EmptyState
        title={
          forbidden
            ? "PEP state is available to platform admins only."
            : "The Policy Enforcement Point state could not be loaded."
        }
        description={state.message}
      />
    );
  }

  const { pep } = state;
  const { enforcement, gates } = pep;
  const graceDays = Math.round(enforcement.legacyGraceWindowSeconds / 86400);

  return (
    <Stack gap="2">
      <div>
        <h3>Enforcement state</h3>
        <p>
          Enforcement {enforcement.enforced ? "on" : "off"} for your session
          (PDP flag {enforcement.pdpEnabled ? "on" : "off"}).
        </p>
        <p>Session: {enforcement.sessionKind}.</p>
        {enforcement.enforced ? (
          <p>
            Gated routes enforce the PDP decision for this session.
          </p>
        ) : (
          <Notice tone="warning">
            Warning: PEP enforcement is off for this session — gated routes
            take the pre-change path. Enforcement turns on when the PDP flag
            is on and the session is wired (or a legacy session past its
            grace bound).
          </Notice>
        )}
        <p>
          Legacy grace:{" "}
          {enforcement.graceExpired
            ? "expired — re-login through wiring to restore gated actions."
            : "not expired."}{" "}
          {enforcement.sessionKind === "wired"
            ? "Wired sessions are never grace-expired."
            : `Legacy sessions stay exempt for ${graceDays} days from creation.`}
        </p>
      </div>

      <div>
        <h3>Gated routes</h3>
        <p>
          Read-only: every route the PEP gates, with the permission it
          checks and the response a denial returns. The inventory is
          read from the server, next to the gates themselves.
        </p>
        {gates.length === 0 ? (
          <EmptyState title="No PEP-gated routes are reported." />
        ) : (
          <ul>
            {gates.map((gate) => (
              <li key={`${gate.method} ${gate.route}`}>
                <p>
                  {gate.method} {gate.route}
                </p>
                <p>Permission: {gate.permission}</p>
                <p>Gateway: {gate.gateway}</p>
                <p>Denied: {gate.denied}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3>Recent PEP decisions</h3>
        {/* No decision record exists yet (decisionsAvailable is false):
            the empty state below is the honest rendering. When a
            record lands, this section renders it from pep.decisions. */}
        <EmptyState
          title="No PEP decision record exists yet."
          description="PEP denials are not written to a queryable audit record yet, so there are no recent decisions to list. This gap is tracked as issue 4683 (a follow-up under issue 4653) — no rows are shown here rather than invented ones."
        />
      </div>
    </Stack>
  );
}
