/**
 * Policy proposals section for the IAAA admin panel (issue #2838).
 *
 * Rendered on the Overview tab beside RoleGrantsPanel: like role
 * grants, policy administration is platform state, so the section
 * lives with them instead of growing a new tab (tab indices
 * unchanged) and is not duplicated anywhere else. Tenant-admins
 * never reach this section: the panel's limited view returns
 * before it, and the server refuses non-platform callers with 403.
 *
 * The editor renders the server's active snapshot (roles and
 * permissions as the server reports them) as grant checkboxes;
 * proposing sends the edited snapshot, which the server validates
 * via parsePolicySnapshot(). A proposal has no effect until a
 * different platform admin approves it and it is promoted — the
 * panel surfaces that status explicitly, and preview shows the
 * grant diff and changed decisions BEFORE approval. Nothing
 * client-side decides authorization: every button calls a real
 * endpoint, and a server refusal surfaces as an error instead of
 * a hidden button.
 *
 * The frozen OBLIGATION_POLICY (#1751) is not editable here: its
 * scope is a carried question, so this panel edits role grants
 * only and says so.
 *
 * All calls go through src/client/policyProposalsApi.ts (apiFetch, the #71 rule).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, EmptyState, Notice, Spinner, TextInput } from "./components/ui";
import {
  approvePolicyProposal,
  fetchActivePolicy,
  fetchPolicyProposals,
  fmtPolicyTime,
  previewPolicy,
  promotePolicyProposal,
  proposePolicy,
  rejectPolicyProposal,
  type PolicyDecisionChange,
  type PolicyGrantChange,
  type PolicyProposalInfo,
  type PolicySnapshotInfo,
} from "./policyProposalsApi";

export function PolicyProposalsPanel() {
  const [proposals, setProposals] = useState<PolicyProposalInfo[]>([]);
  const [active, setActive] = useState<PolicySnapshotInfo | null>(null);
  const [activeSource, setActiveSource] = useState("");
  const [draft, setDraft] = useState<PolicySnapshotInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    diff: PolicyGrantChange[];
    changedDecisions: PolicyDecisionChange[];
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [exceptionReason, setExceptionReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listed, current] = await Promise.all([
        fetchPolicyProposals(),
        fetchActivePolicy(),
      ]);
      setProposals(listed);
      setActive(current.active);
      setActiveSource(current.source);
      setDraft(current.active);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load policy proposals.");
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleGrant = (role: string, permission: string) => {
    if (!draft) return;
    const grants = draft.roleGrants[role] ?? [];
    const next = grants.includes(permission)
      ? grants.filter((p) => p !== permission)
      : [...grants, permission];
    setDraft({
      ...draft,
      roleGrants: { ...draft.roleGrants, [role]: next },
    });
    setPreview(null);
  };

  const doPreview = async () => {
    if (!draft) return;
    setPreviewing(true);
    setError("");
    try {
      setPreview(await previewPolicy(draft));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  };

  const doPropose = async () => {
    if (!draft) return;
    setProposing(true);
    setError("");
    setNotice("");
    try {
      const created = await proposePolicy(draft);
      setNotice(`Proposal ${created.proposalId} created — it has no effect until approved and promoted.`);
      setPreview(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Propose failed.");
    } finally {
      setProposing(false);
    }
  };

  const act = async (
    proposalId: string,
    fn: (id: string) => Promise<PolicyProposalInfo>,
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

  if (loading) return <Spinner />;
  if (error && !active) {
    return <Notice tone="danger">{error}</Notice>;
  }

  return (
    <div className="policy-proposals-panel">
      {error !== "" && <Notice tone="danger">{error}</Notice>}
      {notice !== "" && <Notice tone="success">{notice}</Notice>}
      <p className="iaaa-admin-note">
        Policy proposals are platform-admin only. A proposal has no effect until a
        different platform admin approves it and it is promoted; the compiled policy
        stays active until then. Active source: {activeSource}. The frozen obligation
        policy is not editable here.
      </p>
      {draft && (
        <>
          <h5>Propose a policy change</h5>
          <p className="iaaa-admin-note">
            Active version: <code>{draft.version}</code>. Toggle grants, preview the
            impact, then propose.
          </p>
          {Object.keys(draft.roleGrants).map((role) => (
            <div key={role}>
              <strong>{role}</strong>
              <div>
                {draft.permissions.map((permission) => (
                  <Checkbox
                    key={`${role}:${permission}`}
                    label={permission}
                    checked={(draft.roleGrants[role] ?? []).includes(permission)}
                    onChange={() => toggleGrant(role, permission)}
                  />
                ))}
              </div>
            </div>
          ))}
          <div>
            <Button onClick={doPreview} loading={previewing} disabled={previewing}>
              Preview impact
            </Button>{" "}
            <Button onClick={doPropose} loading={proposing} disabled={proposing}>
              Propose change
            </Button>
          </div>
          {preview && (
            <div>
              <h5>Preview — no privilege change is silent</h5>
              {preview.diff.length === 0 ? (
                <p>No grant changes.</p>
              ) : (
                <ul>
                  {preview.diff.map((d) => (
                    <li key={`${d.role}:${d.permission}`}>
                      {d.role}: {d.permission} {d.change}
                    </li>
                  ))}
                </ul>
              )}
              {preview.changedDecisions.length === 0 ? (
                <p>No decisions change.</p>
              ) : (
                <ul>
                  {preview.changedDecisions.map((d) => (
                    <li key={`${d.role}:${d.permission}`}>
                      {d.role} / {d.permission}: {d.before} → {d.after}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      <h5>Proposals</h5>
      {proposals.length === 0 ? (
        <EmptyState
          title="No policy proposals"
          description="No proposals have been created yet."
        />
      ) : (
        <ul>
          {proposals.map((p) => (
            <li key={p.proposalId}>
              <code>{p.proposalId}</code> — {p.status} — proposed by {p.proposer}
              {p.approver ? `, reviewed by ${p.approver}` : ""}
              {p.exceptionReason ? ` (exception: ${p.exceptionReason})` : ""}
              {" — "}
              {p.beforeRef} → {p.afterRef} — {fmtPolicyTime(p.createdAtMs)}
              {p.status === "proposed" && (
                <span>
                  {" "}
                  <Button
                    onClick={() => void act(p.proposalId, (id) => approvePolicyProposal(id, exceptionReason))}
                    disabled={actingId === p.proposalId}
                  >
                    Approve
                  </Button>{" "}
                  <Button
                    onClick={() => void act(p.proposalId, rejectPolicyProposal)}
                    disabled={actingId === p.proposalId}
                  >
                    Reject
                  </Button>
                </span>
              )}
              {p.status === "approved" && (
                <span>
                  {" "}
                  <Button
                    onClick={() => void act(p.proposalId, promotePolicyProposal)}
                    disabled={actingId === p.proposalId}
                  >
                    Promote
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <TextInput
          label="Exception reason (only for self-approval, which needs a named reason)"
          value={exceptionReason}
          onChange={(event) => setExceptionReason(event.target.value)}
        />
      </div>
    </div>
  );
}
