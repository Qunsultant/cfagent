/**
 * Issue #4655 — the SecHub PIP tab panel: the Policy Information
 * Point's live state, read-only.
 *
 * Reads live state only, from one real source:
 * - GET /api/security/pip (new, this slice) for the attribute
 *   schema (Membership, RoleBinding, PermissionDenial fields), the
 *   attribute sources (membership store via
 *   membershipStoreToAttributeProvider; KV denial store), and the
 *   signed-in user's OWN attributes (memberships + denials) as
 *   resolved through the live AttributeProvider.
 *
 * No enforcement change lives here: the panel renders what the
 * server reports, and the server resolves attributes for the
 * caller's session only — there is no control on this tab that
 * reads another user's attributes (that lookup is out of scope,
 * filed as issue 4661 under issue 4655).
 *
 * Honest empty states: a caller with no memberships or no denials
 * sees an empty state, never invented rows.
 *
 * Composed from ui/ primitives (ADR-0004): Stack for layout, Spinner
 * for loading, EmptyState for honest empty states. No bespoke
 * className tokens, no inline styles, no CSS imports.
 */
import { useEffect, useState } from "react";
import { CardHeader, EmptyState, Spinner, Stack } from "./components/ui";
import { formatMembershipStatus, membershipStatus } from "./iaaaAdminApi";
import { formatIdentityText, Identity } from "./identityDisplay";
import { fetchPipState, type PipState } from "./pipApi";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pip: PipState };

export function PipPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchPipState()
      .then((pip) => {
        if (cancelled) return;
        setState({ status: "ready", pip });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load PIP state.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Stack>
        <Spinner label="Loading PIP state" />
        <p>Loading PIP state…</p>
      </Stack>
    );
  }

  if (state.status === "error") {
    return (
      <EmptyState
        title="The Policy Information Point state could not be loaded."
        description={state.message}
      />
    );
  }

  const { pip } = state;
  const { schema, sources, attributes } = pip;

  return (
    <Stack gap="2">
      <div>
        <CardHeader title="Attribute schema" />
        <p>
          The attributes the PDP evaluates, as defined by the live
          AttributeProvider interface. Memberships carry the roles
          the PDP grants from; denials remove one permission for one
          user in one tenant.
        </p>
        <p>Membership fields</p>
        <ul>
          {schema.membership.fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
        <p>RoleBinding fields</p>
        <ul>
          {schema.roleBinding.fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
        <p>PermissionDenial fields</p>
        <ul>
          {schema.permissionDenial.fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </div>

      <div>
        <CardHeader title="Attribute sources" />
        <p>
          Read-only: where each attribute group comes from, and the
          adapter that resolves it. The PDP reads memberships only
          through the provider, never through a store directly.
        </p>
        {sources.length === 0 ? (
          <EmptyState title="No attribute sources are reported." />
        ) : (
          <ul>
            {sources.map((source) => (
              <li key={source.id}>
                <p>{source.name}</p>
                <p>Resolved through {source.via}</p>
                <p>{source.available ? "Available." : "Not available."}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <CardHeader title="Your attributes" />
        <p>
          The attributes the provider resolves for your session.
        </p>
        <p>Memberships</p>
        {attributes.memberships.length === 0 ? (
          <EmptyState title="No memberships found for your account." />
        ) : (
          <ul>
            {attributes.memberships.map((membership) => (
              <li key={membership.membershipId}>
                <p>Tenant: {membership.tenantId}</p>
                {/* #6164 (F6) — the membership is a login beside its id,
                with the same status wording as the Members table. */}
                <p>
                  Membership: <Identity login={membership.login} id={membership.membershipId} />
                  {" — "}
                  {formatMembershipStatus(membershipStatus(membership, Date.now()))}
                </p>
                <ul>
                  {membership.roleBindings.map((binding, index) => (
                    <li key={`${membership.membershipId}-${index}`}>
                      <p>
                        {binding.role} ({binding.scope})
                      </p>
                      <p>Granted by {formatIdentityText(binding.grantedByLogin, binding.grantedBy)}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <p>Permission denials</p>
        {!attributes.denialsAvailable ? (
          <EmptyState
            title="No denial source is available."
            description="The denial store could not be read, so no denials are listed rather than invented ones."
          />
        ) : attributes.denials.length === 0 ? (
          <EmptyState title="No permission denials recorded for you." />
        ) : (
          <ul>
            {attributes.denials.map((denial) => (
              <li key={denial.denialId}>
                <p>Permission: {denial.permission}</p>
                <p>Tenant: {denial.tenantId}</p>
                <p>Denial: {denial.denialId}</p>
                <p>Denied by {formatIdentityText(denial.deniedByLogin, denial.deniedBy)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Stack>
  );
}
