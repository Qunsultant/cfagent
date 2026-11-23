/**
 * Bootstrap proposals section for the IAAA admin panel (issue 3077,
 * 945 Q3).
 *
 * Rendered on the Overview tab beside RoleGrantsPanel: like
 * role grants, bootstrap administration is platform state, so
 * the section lives with them instead of growing a new tab (tab
 * indices unchanged) and is not duplicated anywhere else.
 * Tenant-admins never reach this section: the panel's limited view
 * returns before it, and the server refuses non-platform callers
 * with 403.
 *
 * A proposal is inert: it changes nothing until a different
 * platform admin approves it, and approval changes nothing until
 * the operator confirms application — the list itself stays in the
 * IAAA_BOOTSTRAP_ADMINS env var and is changed through the secrets
 * channel, never by this panel. Removing an identifier never drops
 * a membership: it stays until explicitly revoked, and the current
 * view surfaces bootstrap-granted members no longer listed.
 * After genesis, a platform: entry grants tenant-admin only (the
 * genesis-closed path); platform-admin grants go through Role
 * grants, never through this list. The FIRST platform admin cannot
 * be approved here (no reviewer exists yet) — initial genesis
 * stays owner-via-secrets + audited.
 *
 * Nothing client-side decides authorization: every button calls a
 * real endpoint, and a server refusal surfaces as an error instead
 * of a hidden button.
 *
 * All calls go through src/client/bootstrapProposalsApi.ts (apiFetch,
 * the #71 rule).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Flex, Notice, Select, Spinner, Stack, TextInput } from "./components/ui";
import { formatIdentityText } from "./identityDisplay";
import {
  approveBootstrapProposal,
  confirmBootstrapApplied,
  fetchBootstrapCurrent,
  fetchBootstrapProposals,
  fmtBootstrapTime,
  proposeBootstrapChange,
  rejectBootstrapProposal,
  type BootstrapCurrentInfo,
  type BootstrapProposalInfo,
} from "./bootstrapProposalsApi";

export function BootstrapProposalsPanel() {
  const [proposals, setProposals] = useState<BootstrapProposalInfo[]>([]);
  const [current, setCurrent] = useState<BootstrapCurrentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<"add" | "remove">("add");
  const [identifier, setIdentifier] = useState("");
  const [reason, setReason] = useState("");
  const [proposing, setProposing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [exceptionReason, setExceptionReason] = useState("");
  const [applicationNote, setApplicationNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listed, currentList] = await Promise.all([
        fetchBootstrapProposals(),
        fetchBootstrapCurrent(),
      ]);
      setProposals(listed);
      setCurrent(currentList);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load bootstrap proposals.");
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doPropose = async () => {
    setProposing(true);
    setError("");
    setNotice("");
    try {
      const created = await proposeBootstrapChange(action, identifier.trim(), reason.trim());
      setNotice(
        `Proposal ${created.proposalId} created — it changes nothing until approved, and approval changes nothing until application is confirmed.`,
      );
      setIdentifier("");
      setReason("");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Propose failed.");
    } finally {
      setProposing(false);
    }
  };

  const act = async (
    proposalId: string,
    fn: (id: string) => Promise<BootstrapProposalInfo>,
  ) => {
    setActingId(proposalId);
    setError("");
    setNotice("");
    try {
      const updated = await fn(proposalId);
      setNotice(`Proposal ${proposalId} is now ${updated.status}.`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setActingId(null);
    }
  };

  return (
    // #6164 (A3) — retired loggedInUsersPanel.deprecated.css (shared with
    // LoggedInUsersPanel): layout and text come from the ui primitives
    // only (Stack/Flex/Card + ui-meta), the ApiKeysPanel pattern.
    <Stack gap="3">
      <p className="ui-meta">
        Reviewed bootstrap changes (945 Q3). A proposal changes nothing until a different
        platform admin approves it, and approval changes nothing until the operator confirms
        application through the secrets channel — this panel never writes the bootstrap list
        itself, which stays in the IAAA_BOOTSTRAP_ADMINS env var. Removing an identifier never
        drops a membership: it stays until explicitly revoked. After genesis, a platform: entry
        grants tenant-admin only; platform-admin grants go through Role grants. The first
        platform admin cannot be approved here (no reviewer exists yet).
      </p>
      {notice !== "" && <Notice tone="success">{notice}</Notice>}
      {error !== "" && <Notice tone="danger">{error}</Notice>}
      {loading && (
        <Flex gap="2" align="center">
          <Spinner size="sm" /> <span className="ui-meta">Loading bootstrap proposals…</span>
        </Flex>
      )}
      {!loading && current && (
        <Card padding="sm">
          <Stack gap="1">
            <strong>Current bootstrap list</strong>
            <span className="ui-meta">
              {current.entries.length === 0
                ? "No entries."
                : current.entries.join(", ")}
            </span>
            {current.resolvedInternalUserIds.length > 0 && (
              <span className="ui-meta">
                Resolved to:{" "}
                {current.resolvedInternalUserIds
                  .map((id, i) =>
                    formatIdentityText(current.resolvedLogins?.[i], id),
                  )
                  .join("; ")}
              </span>
            )}
            {current.unresolvedEntries.length > 0 && (
              <span className="ui-meta">
                Unresolved (match nobody): {current.unresolvedEntries.join(", ")}
              </span>
            )}
            {current.divergence.length > 0 && (
              <span className="ui-meta">
                Granted via bootstrap but no longer listed (membership stays until explicitly
                revoked):{" "}
                {current.divergence
                  .map((d) => `${formatIdentityText(d.login, d.internalUserId)} (${d.roles.join(", ")} via ${d.grantedVia})`)
                  .join("; ")}
              </span>
            )}
          </Stack>
        </Card>
      )}
      <Card padding="sm">
        <Stack gap="1">
          <strong>Propose a bootstrap change</strong>
          <Flex gap="2" align="end" wrap>
            {/* Issue #4839 G8: visible labels, not aria-label only. */}
            <Select
              label="Change action"
              value={action}
              onChange={(e) => setAction(e.target.value as "add" | "remove")}
            >
              <option value="add">add</option>
              <option value="remove">remove</option>
            </Select>{" "}
            <TextInput
              label="Bootstrap identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="UUID, v1: id, issuer:subject, or platform: entry"
            />{" "}
            <TextInput
              label="Proposal reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason (required)"
            />{" "}
            <Button disabled={proposing} onClick={() => void doPropose()}>
              Propose
            </Button>
          </Flex>
        </Stack>
      </Card>
      {!loading && proposals.length === 0 && (
        <EmptyState title="No bootstrap proposals" description="No bootstrap proposals exist yet." />
      )}
      {!loading && proposals.length > 0 && (
        <Stack gap="2">
          {proposals.map((p) => (
            <Card key={p.proposalId} padding="sm">
              <Stack gap="1">
                <strong>
                  {p.action} {p.identifier}
                </strong>
                <span className="ui-meta">
                  Status: {p.status} · Proposed by {formatIdentityText(p.proposerLogin, p.proposer)} · Reason: {p.reason}
                </span>
                <span className="ui-meta">
                  Created: {fmtBootstrapTime(p.createdAtMs)}
                  {p.approver ? ` · Reviewed by ${formatIdentityText(p.approverLogin, p.approver)}` : ""}
                  {p.exceptionReason ? ` · Self-approval reason: ${p.exceptionReason}` : ""}
                  {p.appliedBy ? ` · Applied by ${formatIdentityText(p.appliedByLogin, p.appliedBy)}` : ""}
                  {p.applicationNote ? ` · Note: ${p.applicationNote}` : ""}
                </span>
                {p.retained && (
                  <span className="ui-meta">
                    Removal retains membership {p.retained.membershipId} for{" "}
                    {formatIdentityText(p.retained.login, p.retained.internalUserId)} until explicitly revoked.
                  </span>
                )}
                {p.status === "proposed" && (
                  <Flex gap="2" align="end" wrap>
                    <TextInput
                      aria-label="Exception reason for self-approval"
                      value={exceptionReason}
                      onChange={(e) => setExceptionReason(e.target.value)}
                      placeholder="exception reason (required to approve your own proposal)"
                    />{" "}
                    <Button
                      disabled={actingId === p.proposalId}
                      onClick={() =>
                        void act(p.proposalId, (id) =>
                          approveBootstrapProposal(
                            id,
                            exceptionReason.trim() !== "" ? exceptionReason.trim() : undefined,
                          ),
                        )
                      }
                    >
                      Approve
                    </Button>{" "}
                    <Button
                      disabled={actingId === p.proposalId}
                      onClick={() => void act(p.proposalId, (id) => rejectBootstrapProposal(id))}
                    >
                      Reject
                    </Button>
                  </Flex>
                )}
                {p.status === "approved" && (
                  <Flex gap="2" align="end" wrap>
                    <TextInput
                      aria-label="Application note"
                      value={applicationNote}
                      onChange={(e) => setApplicationNote(e.target.value)}
                      placeholder="application note (e.g. secrets updated, deploy synced)"
                    />{" "}
                    <Button
                      disabled={actingId === p.proposalId}
                      onClick={() =>
                        void act(p.proposalId, (id) =>
                          confirmBootstrapApplied(
                            id,
                            applicationNote.trim() !== "" ? applicationNote.trim() : undefined,
                          ),
                        )
                      }
                    >
                      Confirm applied
                    </Button>
                  </Flex>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
      <p className="ui-meta">
        Every transition is audited through the chained audit store before it is stored. A
        failed audit append stores nothing.
      </p>
    </Stack>
  );
}
