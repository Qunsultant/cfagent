/**
 * Agents — the fleet exactly as the G0 registry records it.
 *
 * The page is deliberately a read surface. It fetches
 * `GET /api/agents/registry` (issue #2469, Agent Mesh S20/G9) and
 * renders only what the registry (src/agents/registry.ts) records:
 * every Durable Object class with its bindings, its recorded
 * status and — where degraded — the recorded reason; the S15
 * capability × door census with each door's gate (or the recorded
 * reason a door does not serve the class); each class's S16
 * identity and credential posture (env names only, never values);
 * the workflows, channels, and tool families with their recorded
 * statuses; the S19 per-door cost budgets; and the programme
 * records (S18's G12 proof, S17's trace spine with its recorded
 * breaks, S19's Skills assessment).
 *
 * Nothing here is a second list: the payload is derived from the
 * registry module at request time and drift-pinned against it
 * (tests/mesh_agents_view_s20_2469.test.ts), so this page cannot
 * silently diverge from the source of truth. A field the registry
 * does not record renders as absent — never invented.
 *
 * Compliance (docs/architecture/UX/ux-architecture.md §20): ui/ primitives
 * only, semantic tokens only, server state is authoritative, the
 * view issues no mutations.
 */

import React, { useEffect, useState } from "react";
import "./agentsPanel.css";
import {
  Badge,
  Card,
  EmptyState,
  PageSection,
  PageShell,
  Table,
  type TableColumn,
} from "./components/ui";
import type {
  MeshAgentView,
  MeshDoorView,
  MeshRegistryView,
} from "../services/meshRegistryView";

type WorkflowRow = MeshRegistryView["workflows"][number];
type ChannelRow = MeshRegistryView["channels"][number];
type ToolFamilyRow = MeshRegistryView["toolFamilies"][number];
type CensusRow = MeshAgentView["doors"][number];

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "live" || status === "exposed") return "success";
  if (status === "degraded") return "warning";
  if (status === "absent") return "danger";
  return "neutral";
}

export function AgentsPanel() {
  const [view, setView] = useState<MeshRegistryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agents/registry");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as MeshRegistryView;
        if (cancelled) return;
        setView(body);
        setSelectedClass(body.agents[0]?.className ?? null);
      } catch {
        if (!cancelled) {
          setError(
            "The agent registry could not be loaded. Reload to try again.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = view?.agents.find((a) => a.className === selectedClass) ?? null;
  const doorName = (id: string) =>
    view?.doors.find((d) => d.id === id)?.name ?? id;

  const fleetColumns: TableColumn<MeshAgentView>[] = [
    {
      key: "class",
      header: "Class",
      render: (agent) => (
        <div className="agents-panel-stack">
          <span className="agents-panel-mono">{agent.className}</span>
          <span className="agents-panel-sub">
            {agent.kind} · {agent.base}
          </span>
        </div>
      ),
    },
    {
      key: "bindings",
      header: "Bindings",
      render: (agent) => (
        <span className="agents-panel-mono">{agent.bindings.join(", ")}</span>
      ),
    },
    {
      key: "status",
      header: "Status (as recorded)",
      render: (agent) => (
        <div className="agents-panel-stack">
          <Badge tone={statusTone(agent.status)}>{agent.status}</Badge>
          {agent.status === "degraded" ? (
            <span className="agents-panel-sub">{agent.statusReason}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "doors",
      header: "Doors",
      render: (agent) => {
        const exposed = agent.doors.filter((d) => d.status === "exposed");
        return (
          <div className="agents-panel-stack">
            <span>
              {exposed.length} of {agent.doors.length} exposed
            </span>
            <span className="agents-panel-sub">
              {exposed.map((d) => doorName(d.door)).join(", ") || "none"}
            </span>
          </div>
        );
      },
    },
    {
      key: "credentials",
      header: "Mesh credentials (env names)",
      render: (agent) =>
        agent.identity && agent.identity.meshCredentials.length > 0 ? (
          <span className="agents-panel-mono">
            {agent.identity.meshCredentials.join(", ")}
          </span>
        ) : (
          <span className="agents-panel-sub">No A2A credential</span>
        ),
    },
  ];

  const censusColumns: TableColumn<CensusRow>[] = [
    {
      key: "door",
      header: "Door",
      render: (cell) => doorName(cell.door),
    },
    {
      key: "status",
      header: "Status",
      render: (cell) => (
        <Badge tone={statusTone(cell.status)}>{cell.status}</Badge>
      ),
    },
    {
      key: "operations",
      header: "Operations",
      render: (cell) =>
        cell.operations.length > 0 ? (
          <span className="agents-panel-mono">{cell.operations.join(", ")}</span>
        ) : (
          <span className="agents-panel-sub">Not enumerable — see gate / reason</span>
        ),
    },
    {
      key: "gate",
      header: "Gate / recorded reason",
      render: (cell) => cell.gate ?? cell.reason ?? "",
    },
  ];

  const doorColumns: TableColumn<MeshDoorView>[] = [
    { key: "door", header: "Door", render: (door) => door.name },
    { key: "entry", header: "Entry point", render: (door) => door.entryPoint },
    { key: "gate", header: "Gate", render: (door) => door.gate },
    {
      key: "budget",
      header: "Cost budget (S19)",
      render: (door) => (
        <div className="agents-panel-stack">
          <span>{door.budget.unit}</span>
          <span className="agents-panel-sub">
            {door.budget.caps
              ? `Caps: ${door.budget.caps.perCall ?? "—"} per call · ${door.budget.caps.perDay ?? "—"} per day`
              : "No cap recorded"}
            {" · "}
            <Badge tone={door.budget.enforcement === "enforced" ? "success" : "neutral"}>
              {door.budget.enforcement}
            </Badge>
          </span>
        </div>
      ),
    },
  ];

  const workflowColumns: TableColumn<WorkflowRow>[] = [
    {
      key: "class",
      header: "Workflow",
      render: (w) => <span className="agents-panel-mono">{w.className}</span>,
    },
    {
      key: "binding",
      header: "Binding",
      render: (w) => <span className="agents-panel-mono">{w.binding}</span>,
    },
    { key: "starters", header: "Started by", render: (w) => w.starters.join("; ") },
    { key: "role", header: "Role", render: (w) => w.role },
  ];

  const channelColumns: TableColumn<ChannelRow>[] = [
    { key: "name", header: "Channel", render: (c) => c.name },
    { key: "ingress", header: "Ingress", render: (c) => c.ingress },
    { key: "terminates", header: "Terminates at", render: (c) => c.terminatesAt },
    {
      key: "posture",
      header: "Posture",
      render: (c) => <Badge tone="neutral">{c.posture}</Badge>,
    },
    { key: "gate", header: "Gate", render: (c) => c.gate },
  ];

  const familyColumns: TableColumn<ToolFamilyRow>[] = [
    {
      key: "family",
      header: "Tool family",
      render: (f) => (
        <div className="agents-panel-stack">
          <span>{f.name}</span>
          <span className="agents-panel-sub agents-panel-mono">{f.id}</span>
        </div>
      ),
    },
    { key: "source", header: "Source", render: (f) => f.source },
    {
      key: "status",
      header: "Status (as recorded)",
      render: (f) => <Badge tone={statusTone(f.status)}>{f.status}</Badge>,
    },
    {
      key: "commands",
      header: "Commands / tools",
      render: (f) => String(f.commands.length + (f.toolNames?.length ?? 0)),
    },
  ];

  return (
    <div className="agents-panel-page">
      <PageShell
        title="Agents"
        scopeNote="The agent fleet exactly as the G0 registry (src/agents/registry.ts) records it — classes, doors and gates, identity and credential posture, and the honest degraded/absent records. Read-only; the registry is the source of truth."
        loading={loading}
        loadingLabel="Loading the agent registry"
        error={error}
      >
        {view ? (
          <>
            <PageSection
              title="Fleet"
              description={`${view.counts.agents} classes · ${view.counts.surfaces} A2A surfaces · ${view.counts.censusCells} capability × door census cells (${view.counts.censusExposed} exposed). Select a class for its doors and identity record.`}
            >
              <Table
                columns={fleetColumns}
                rows={view.agents}
                rowKey={(agent) => agent.className}
                onRowClick={(agent) => setSelectedClass(agent.className)}
                empty={
                  <EmptyState
                    title="No classes recorded"
                    description="The registry records no agent classes."
                  />
                }
              />
              {selected ? (
                <div className="agents-panel-detail">
                  <Card>
                    <div className="agents-panel-stack">
                      <span className="agents-panel-mono">{selected.className}</span>
                      <span>{selected.role}</span>
                      <span className="agents-panel-sub">
                        Recorded status: {selected.status} — {selected.statusReason}
                      </span>
                      {selected.notes ? (
                        <span className="agents-panel-sub">{selected.notes}</span>
                      ) : null}
                    </div>
                  </Card>
                  <Table
                    columns={censusColumns}
                    rows={selected.doors}
                    rowKey={(cell) => `${selected.className}:${cell.door}`}
                    caption={`${selected.className} — capability × door census`}
                  />
                  <Card>
                    <div className="agents-panel-stack">
                      <span className="agents-panel-label">Identity & credential posture</span>
                      {selected.identity ? (
                        <>
                          <span>
                            DID:{" "}
                            <span className="agents-panel-mono">
                              {selected.identity.did ?? "none registered"}
                            </span>
                          </span>
                          <span className="agents-panel-sub">
                            {selected.identity.identitySource}
                          </span>
                          <span>
                            A2A surfaces:{" "}
                            {selected.identity.a2aSurfaces.join(", ") || "none"}
                          </span>
                          <span>
                            Mesh credentials:{" "}
                            <span className="agents-panel-mono">
                              {selected.identity.meshCredentials.join(", ") ||
                                "none"}
                            </span>
                          </span>
                          <span className="agents-panel-sub">
                            {selected.identity.credentialPosture}
                          </span>
                          <span className="agents-panel-sub">
                            {selected.identity.attribution}
                          </span>
                        </>
                      ) : (
                        <span className="agents-panel-sub">
                          No identity record is registered for this class.
                        </span>
                      )}
                    </div>
                  </Card>
                </div>
              ) : null}
            </PageSection>

            <PageSection
              title="Doors & cost budgets"
              description="The five invocation surfaces, their enforcement points, and the per-door cost budgets recorded by S19 — a cap appears only where a real enforcing surface charges a real ledger."
            >
              <Table columns={doorColumns} rows={view.doors} rowKey={(d) => d.id} />
            </PageSection>

            <PageSection title="Workflows">
              <Table
                columns={workflowColumns}
                rows={view.workflows}
                rowKey={(w) => w.className}
              />
            </PageSection>

            <PageSection title="Channels">
              <Table
                columns={channelColumns}
                rows={view.channels}
                rowKey={(c) => c.id}
              />
            </PageSection>

            <PageSection title="Tool families">
              <Table
                columns={familyColumns}
                rows={view.toolFamilies}
                rowKey={(f) => f.id}
              />
            </PageSection>

            <PageSection
              title="Programme records"
              description="What the Agent Mesh programme recorded about itself: the G12 proof, the unified trace spine with its recorded breaks, the mesh credential inventory, and the Skills-packaging assessment."
            >
              <div className="agents-panel-cards">
                <Card>
                  <div className="agents-panel-stack">
                    <span className="agents-panel-label">
                      G12 — every capability, every door
                    </span>
                    <Badge tone="success">{view.programme.g12Proof.status}</Badge>
                    <span className="agents-panel-sub">
                      {view.programme.g12Proof.scope}
                    </span>
                    <span className="agents-panel-sub">
                      Golden-task catalog: {view.programme.g12Proof.catalog};
                      results store: {view.programme.g12Proof.store}.
                    </span>
                  </div>
                </Card>
                <Card>
                  <div className="agents-panel-stack">
                    <span className="agents-panel-label">
                      Trace spine — recorded breaks
                    </span>
                    {view.programme.traceBreaks.map((brk) => (
                      <span key={brk.hop} className="agents-panel-sub">
                        {brk.hop}: {brk.consequence}
                      </span>
                    ))}
                  </div>
                </Card>
                <Card>
                  <div className="agents-panel-stack">
                    <span className="agents-panel-label">
                      Mesh credential inventory (env names only)
                    </span>
                    <span className="agents-panel-mono">
                      {view.programme.credentialEnvNames.join(", ")}
                    </span>
                    <span className="agents-panel-sub">
                      Each surface's own credential, verified at the A2A edge;
                      a surface without its own secret set authenticates
                      transitionally on the shared token — the per-class
                      posture is in each class's identity record above.
                    </span>
                  </div>
                </Card>
                <Card>
                  <div className="agents-panel-stack">
                    <span className="agents-panel-label">
                      Skills packaging (S19 assessment)
                    </span>
                    <Badge tone="neutral">
                      {view.programme.skillsAssessment.recommendation}
                    </Badge>
                    <span className="agents-panel-sub">
                      {view.programme.skillsAssessment.adoptionState}
                    </span>
                  </div>
                </Card>
              </div>
            </PageSection>
          </>
        ) : null}
      </PageShell>
    </div>
  );
}
