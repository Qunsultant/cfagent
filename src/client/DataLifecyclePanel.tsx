/**
 * Data Lifecycle panel (issue #3250): the Platform Admin section
 * for clean-state reset, platform bootstrap, and tenant
 * bootstrap, over src/agents/routes/dataLifecycle.ts via
 * dataLifecycleApi.ts.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20,
 * following the AdminQueueWipePanel idiom: preview first
 * (fail-closed, nothing destructive), modal confirm, then the
 * confirmed result rendered as the verify step.
 *
 * Scope honesty, stated on the surface:
 * - Tenant clean state touches ONLY the named tenant's member
 *   instances, memberships, genesis marker, and member sessions;
 *   the server binds the confirm to the preview the operator saw
 *   (preview token), so a confirm can never widen the scope.
 * - Platform clean state is platform-wide by definition. Its
 *   confirm stays disabled until the pre-wipe export bundle has
 *   been downloaded from this surface AND the operator types the
 *   scope phrase — the export-before-confirm rule the issue
 *   requires.
 * - Every confirmed operation is audited AFTER its writes
 *   through the AuditLog port; the result states plainly when
 *   the audit record was written, and when it was not.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Modal,
  Notice,
  SegmentedControl,
  Select,
  Spinner,
  Stack,
  Table,
  TextInput,
} from "./components/ui";
import { downloadTextFile } from "./runExport";
import { fetchTenants, type TenantListRow } from "./tenantAdminApi";
import {
  checkPlatformBootstrap,
  confirmCleanState,
  confirmRecreate,
  fetchDataLifecycleExport,
  initializePlatformBootstrap,
  previewCleanState,
  previewRecreate,
  previewTenantBootstrap,
  runTenantBootstrap,
  type BootstrapElement,
  type CleanPreview,
  type CleanResult,
  type CleanScope,
  type CleanTarget,
  type PlatformBootstrapReport,
  type RecreatePreview,
  type RecreateResult,
  type RecreateStepDescriptor,
  type TenantBootstrapReport,
} from "./dataLifecycleApi";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Request failed.";
}

function stateTone(state: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (state) {
    case "present":
    case "initialized":
      return "success";
    case "missing":
    case "would-initialize":
      return "warning";
    case "failed":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}

function AuditLine({ audit }: { audit?: CleanResult["audit"] }) {
  if (!audit) return null;
  return audit.auditLog.ok ? (
    <Notice tone="success">
      Audit record written to the audit log after the operation — it
      survives the clear it describes.
    </Notice>
  ) : (
    <Notice tone="danger">
      Audit record FAILED{ audit.auditLog.error ? `: ${audit.auditLog.error}` : ""}.
      The operation itself completed; do not treat it as audited.
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Clean state
// ---------------------------------------------------------------------------

function CleanStateCard() {
  const [tenants, setTenants] = useState<TenantListRow[]>([]);
  const [tenantsError, setTenantsError] = useState("");
  const [scope, setScope] = useState<CleanScope>("tenant");
  const [tenantId, setTenantId] = useState("");
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const [result, setResult] = useState<CleanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [auditChecked, setAuditChecked] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTenants()
      .then((rows) => {
        if (cancelled) return;
        setTenants(rows);
        if (rows.length > 0) setTenantId((prev) => prev || rows[0].tenantId);
      })
      .catch((err) => {
        if (!cancelled) setTenantsError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetFlow = useCallback(() => {
    setPreview(null);
    setResult(null);
    setConfirmText("");
    setAuditChecked(false);
    setExported(false);
    setError("");
  }, []);

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setPreview(
        await previewCleanState(scope, scope === "tenant" ? tenantId : undefined),
      );
    } catch (err) {
      setPreview(null);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, [scope, tenantId]);

  const onExport = useCallback(async () => {
    setExportBusy(true);
    setError("");
    try {
      const bundle = await fetchDataLifecycleExport(
        scope,
        scope === "tenant" ? tenantId : undefined,
      );
      downloadTextFile(
        `data-lifecycle-export-${scope}${scope === "tenant" ? `-${tenantId}` : ""}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(bundle, null, 2),
        "application/json",
      );
      setExported(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setExportBusy(false);
    }
  }, [scope, tenantId]);

  const canConfirm =
    preview !== null &&
    auditChecked &&
    (scope === "tenant" || (exported && confirmText === "CLEAN PLATFORM"));

  const onConfirm = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const out = await confirmCleanState({
        scope,
        tenantId: scope === "tenant" ? tenantId : undefined,
        previewToken: preview.previewToken,
        confirmText: scope === "platform" ? confirmText : undefined,
        auditConfirm: true,
      });
      setResult(out);
      setPreview(null);
      setModalOpen(false);
    } catch (err) {
      setError(messageOf(err));
      setModalOpen(false);
    } finally {
      setBusy(false);
    }
  }, [preview, scope, tenantId, confirmText]);

  const shownTargets: CleanTarget[] = result?.targets ?? preview?.targets ?? [];

  return (
    <Stack gap="3">
      <div className="section-label-row">
        <span>Clean state</span>
        <small>Preview, export, then clear to the defined clean state</small>
      </div>
      <Notice tone="info">
        Tenant scope clears only the named tenant&apos;s member instances,
        memberships, genesis marker, and member sessions. Platform scope is
        platform-wide and additionally requires a platform-admin membership
        on the server. Tenant directory records, settings, and claim buckets
        are never part of a clean state.
      </Notice>
      {tenantsError && <Notice tone="danger">{tenantsError}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <SegmentedControl<CleanScope>
        ariaLabel="Clean state scope"
        options={[
          { id: "tenant", label: "Tenant" },
          { id: "platform", label: "Platform" },
        ]}
        value={scope}
        onChange={(next) => {
          setScope(next);
          resetFlow();
        }}
      />
      {scope === "tenant" && (
        <Select
          label="Tenant"
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            resetFlow();
          }}
        >
          {tenants.map((t) => (
            <option key={t.tenantId} value={t.tenantId}>
              {t.tenantId}
            </option>
          ))}
        </Select>
      )}
      <div>
        <Button onClick={() => void onPreview()} disabled={busy || (scope === "tenant" && !tenantId)}>
          Preview clean state
        </Button>{" "}
        <Button onClick={() => void onExport()} disabled={exportBusy || (scope === "tenant" && !tenantId)}>
          Download export bundle
        </Button>{" "}
        <Button
          variant="danger"
          onClick={() => setModalOpen(true)}
          disabled={!preview || busy}
        >
          Review and clean
        </Button>
        {busy && <Spinner label="Working" />}
      </div>
      {shownTargets.length > 0 && (
        <Table<CleanTarget>
          columns={[
            {
              key: "target",
              header: "Target",
              render: (row) => (
                <>
                  {row.label} <code>{row.id}</code>
                </>
              ),
            },
            { key: "kind", header: "Kind", render: (row) => row.kind },
            {
              key: "count",
              header: result ? "Deleted" : "Rows / keys",
              render: (row) =>
                result ? String(row.deleted ?? 0) : String(row.count ?? 0),
            },
            {
              key: "status",
              header: "Status",
              render: (row) =>
                row.error ? (
                  <Badge tone="danger">{row.error}</Badge>
                ) : result ? (
                  <Badge tone={row.verified ? "success" : "warning"}>
                    {row.verified ? "verified" : "unverified"}
                  </Badge>
                ) : (
                  <Badge tone="neutral">preview</Badge>
                ),
            },
          ]}
          rows={shownTargets}
          rowKey={(row) => row.id}
        />
      )}
      {result && (
        <>
          <Notice tone="success">
            {scope === "tenant" ? "Tenant" : "Platform"} clean state complete —{" "}
            {result.targets.reduce((n, t) => n + (t.deleted ?? 0), 0)} row(s)/key(s)
            deleted across {result.targets.length} target(s).
          </Notice>
          <AuditLine audit={result.audit} />
        </>
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={scope === "tenant" ? "Confirm tenant clean state" : "Confirm platform clean state"}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              Keep data
            </Button>
            <Button
              onClick={() => void onConfirm()}
              disabled={!canConfirm || busy}
              variant="danger"
            >
              Confirm clean state
            </Button>
          </>
        }
      >
        <Stack gap="3">
          <p>
            This clears exactly the previewed{" "}
            {scope === "tenant" ? `tenant (${tenantId})` : "platform"} scope —
            the confirm is bound to the preview token, so a scope that changed
            since the preview is refused by the server.
          </p>
          {scope === "platform" && (
            <>
              <p>
                Platform clean state requires the pre-wipe export bundle to be
                downloaded first, from this dialog.
              </p>
              <div>
                <Button onClick={() => void onExport()} disabled={exportBusy}>
                  Download pre-wipe export
                </Button>{" "}
                {exported && <Badge tone="success">export downloaded</Badge>}
              </div>
              <TextInput
                label="Type the scope phrase to confirm"
                placeholder="CLEAN PLATFORM"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </>
          )}
          <Checkbox
            label="I confirm the audit-bearing instance table may be cleared (auditConfirm)"
            checked={auditChecked}
            onChange={(e) => setAuditChecked(e.target.checked)}
          />
        </Stack>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Platform bootstrap
// ---------------------------------------------------------------------------

function PlatformBootstrapCard() {
  const [report, setReport] = useState<PlatformBootstrapReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  const onCheck = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await checkPlatformBootstrap());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onInitialize = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await initializePlatformBootstrap());
      setModalOpen(false);
    } catch (err) {
      setError(messageOf(err));
      setModalOpen(false);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Stack gap="3">
      <div className="section-label-row">
        <span>Platform bootstrap</span>
        <small>Initialization elements, checked against their sources of truth</small>
      </div>
      <Notice tone="info">
        The check reports each element present, missing, or external
        (deployment-owned, with no in-route action). Initialize performs the
        missing steps it owns — on a fresh platform, the genesis claim for a
        configured bootstrap admin — and is a no-op report on an initialized
        platform.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <div>
        <Button onClick={() => void onCheck()} disabled={busy}>
          Check platform bootstrap
        </Button>{" "}
        <Button onClick={() => setModalOpen(true)} disabled={busy}>
          Initialize platform
        </Button>
        {busy && <Spinner label="Working" />}
      </div>
      {report && (
        <Table<BootstrapElement>
          columns={[
            { key: "id", header: "Element", render: (row) => <code>{row.id}</code> },
            {
              key: "state",
              header: "State",
              render: (row) => <Badge tone={stateTone(row.state)}>{row.state}</Badge>,
            },
            { key: "detail", header: "Detail", render: (row) => row.detail },
          ]}
          rows={report.elements}
          rowKey={(row) => row.id}
        />
      )}
      {report?.audit && <AuditLine audit={report.audit} />}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm platform initialize"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void onInitialize()} disabled={busy}>
              Confirm initialize
            </Button>
          </>
        }
      >
        <p>
          Initialize runs the bootstrap check and performs the missing steps
          the route owns (the genesis claim, when the caller is a configured
          bootstrap admin). Deployment-owned elements are reported, never
          faked. The run is audited.
        </p>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Tenant bootstrap
// ---------------------------------------------------------------------------

function TenantBootstrapCard() {
  const [tenantId, setTenantId] = useState("");
  const [founderLogin, setFounderLogin] = useState("");
  const [claimGenesis, setClaimGenesis] = useState(false);
  const [preview, setPreview] = useState<TenantBootstrapReport | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [result, setResult] = useState<TenantBootstrapReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  const inputKey = JSON.stringify({
    tenantId: tenantId.trim(),
    founderLogin: founderLogin.trim(),
    claimGenesis,
  });
  const input = {
    tenantId: tenantId.trim(),
    foundingAdminLogin: founderLogin.trim() || undefined,
    claimGenesis,
  };

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const out = await previewTenantBootstrap(input);
      setPreview(out);
      setPreviewKey(inputKey);
    } catch (err) {
      setPreview(null);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, [tenantId, founderLogin, claimGenesis]);

  const onRun = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const out = await runTenantBootstrap(input);
      setResult(out);
      setPreview(null);
      setModalOpen(false);
    } catch (err) {
      setError(messageOf(err));
      setModalOpen(false);
    } finally {
      setBusy(false);
    }
  }, [tenantId, founderLogin, claimGenesis]);

  const shown = result ?? preview;

  return (
    <Stack gap="3">
      <div className="section-label-row">
        <span>Tenant bootstrap</span>
        <small>Full initialization after the directory record, per step</small>
      </div>
      <Notice tone="info">
        Bootstrap creates the tenant record when missing, verifies the
        effective settings through the settings port, grants the founding
        admin tenant-admin, optionally claims genesis for them (which needs
        your own platform-admin membership), and materializes the default
        channel configuration. A founding admin whose identity cannot be
        resolved is reported missing — identity is never invented. Re-running
        reports state without duplicating.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <TextInput
        label="Tenant ID"
        placeholder="e.g. tenant-c"
        value={tenantId}
        onChange={(e) => setTenantId(e.target.value)}
      />
      <TextInput
        label="Founding admin login (optional)"
        placeholder="e.g. founder-login"
        value={founderLogin}
        onChange={(e) => setFounderLogin(e.target.value)}
      />
      <Checkbox
        label="Claim genesis for the founding admin"
        checked={claimGenesis}
        onChange={(e) => setClaimGenesis(e.target.checked)}
      />
      <div>
        <Button onClick={() => void onPreview()} disabled={busy || !tenantId.trim()}>
          Preview tenant bootstrap
        </Button>{" "}
        <Button
          onClick={() => setModalOpen(true)}
          disabled={busy || !preview || previewKey !== inputKey}
        >
          Run tenant bootstrap
        </Button>
        {busy && <Spinner label="Working" />}
      </div>
      {shown && (
        <Table<TenantBootstrapReport["steps"][number]>
          columns={[
            { key: "id", header: "Step", render: (row) => <code>{row.id}</code> },
            {
              key: "status",
              header: "Status",
              render: (row) => <Badge tone={stateTone(row.status)}>{row.status}</Badge>,
            },
            { key: "detail", header: "Detail", render: (row) => row.detail },
          ]}
          rows={shown.steps}
          rowKey={(row) => row.id}
        />
      )}
      {result && (
        <>
          <Notice tone={result.outcome === "complete" ? "success" : "warning"}>
            {result.outcome === "complete"
              ? "Tenant bootstrap complete — every step is in place."
              : "Tenant bootstrap partially complete — the steps above state exactly what is missing; re-running is safe."}
          </Notice>
          {result.settings && (
            <Notice tone="info">
              Effective settings: ads {result.settings.adsEnabled ? "enabled" : "disabled"},
              auto-refresh {result.settings.autoRefreshEnabled ? "enabled" : "disabled"},
              data provider {result.settings.dataProviderId}, broker{" "}
              {result.settings.brokerId}.
            </Notice>
          )}
          <AuditLine audit={result.audit} />
        </>
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm tenant bootstrap"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void onRun()} disabled={busy}>
              Confirm tenant bootstrap
            </Button>
          </>
        }
      >
        <p>
          Run the bootstrap for tenant <code>{tenantId.trim()}</code> exactly as
          previewed. Steps that are already in place report present and change
          nothing; the run is audited.
        </p>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Recreate (#4383)
// ---------------------------------------------------------------------------

/** Display group for a planned step, derived from its code's action. */
function detailGroupOf(code: string): string {
  if (code.startsWith("seed.")) return "seeds";
  if (code.includes(".create_table")) return "creations";
  if (code.includes(".create_index") || code.includes(".create_unique_index")) {
    return "indexes";
  }
  return "reconciliations";
}

interface DetailRow {
  leg: string;
  group: string;
  code: string;
  params: string;
}

function detailRowsOf(preview: RecreatePreview): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const step of preview.d1.selected) {
    rows.push({
      leg: "D1",
      group: detailGroupOf(step.code),
      code: step.code,
      params: paramsText(step),
    });
  }
  for (const instance of preview.instances) {
    for (const step of instance.selected) {
      rows.push({
        leg: instance.login,
        group: detailGroupOf(step.code),
        code: step.code,
        params: paramsText(step),
      });
    }
  }
  return rows;
}

function paramsText(step: RecreateStepDescriptor): string {
  const entries = Object.entries(step.params);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function RecreateCard() {
  const [tenants, setTenants] = useState<TenantListRow[]>([]);
  const [tenantsError, setTenantsError] = useState("");
  const [scope, setScope] = useState<CleanScope>("tenant");
  const [tenantId, setTenantId] = useState("");
  const [preview, setPreview] = useState<RecreatePreview | null>(null);
  const [result, setResult] = useState<RecreateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [auditChecked, setAuditChecked] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTenants()
      .then((rows) => {
        if (cancelled) return;
        setTenants(rows);
        if (rows.length > 0) setTenantId((prev) => prev || rows[0].tenantId);
      })
      .catch((err) => {
        if (!cancelled) setTenantsError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetFlow = useCallback(() => {
    setPreview(null);
    setResult(null);
    setConfirmText("");
    setAuditChecked(false);
    setDetailOpen(false);
    setError("");
  }, []);

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setPreview(
        await previewRecreate(scope, scope === "tenant" ? tenantId : undefined),
      );
    } catch (err) {
      setPreview(null);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, [scope, tenantId]);

  const onDownload = useCallback(() => {
    const payload = result ?? preview;
    if (!payload) return;
    downloadTextFile(
      `data-lifecycle-recreate-${scope}${scope === "tenant" ? `-${tenantId}` : ""}-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json",
    );
  }, [result, preview, scope, tenantId]);

  const canConfirm =
    preview !== null &&
    auditChecked &&
    (scope === "tenant" || confirmText === "CLEAN PLATFORM");

  const onConfirm = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const out = await confirmRecreate({
        scope,
        tenantId: scope === "tenant" ? tenantId : undefined,
        previewToken: preview.previewToken,
        confirmText: scope === "platform" ? confirmText : undefined,
        auditConfirm: true,
      });
      setResult(out);
      setPreview(null);
      setModalOpen(false);
    } catch (err) {
      setError(messageOf(err));
      setModalOpen(false);
    } finally {
      setBusy(false);
    }
  }, [preview, scope, tenantId, confirmText]);

  const shownLayers = result?.uncreatableLayers ?? preview?.uncreatableLayers ?? [];
  const detailRows = preview ? detailRowsOf(preview) : [];
  const d1Executed = result?.d1.report.executed.length ?? 0;
  const d1Failed = result?.d1.report.failed.length ?? 0;

  return (
    <Stack gap="3">
      <div className="section-label-row">
        <span>Recreate schema</span>
        <small>Rebuild the schema on the D1 leg and the member instances</small>
      </div>
      <Notice tone="info">
        The recreate rebuilds SQL schema only: it probes each store, runs
        only the steps that close a diff, and verifies afterwards. A second
        run is a no-op. The layers below cannot be rebuilt from a route —
        they are reported, never faked.
      </Notice>
      {tenantsError && <Notice tone="danger">{tenantsError}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <SegmentedControl<CleanScope>
        ariaLabel="Recreate scope"
        options={[
          { id: "tenant", label: "Tenant" },
          { id: "platform", label: "Platform" },
        ]}
        value={scope}
        onChange={(next) => {
          setScope(next);
          resetFlow();
        }}
      />
      {scope === "tenant" && (
        <Select
          label="Tenant"
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            resetFlow();
          }}
        >
          {tenants.map((t) => (
            <option key={t.tenantId} value={t.tenantId}>
              {t.tenantId}
            </option>
          ))}
        </Select>
      )}
      <div>
        <Button onClick={() => void onPreview()} disabled={busy || (scope === "tenant" && !tenantId)}>
          Preview recreate
        </Button>{" "}
        <Button
          variant="danger"
          onClick={() => setModalOpen(true)}
          disabled={!preview || busy}
        >
          Review and recreate
        </Button>{" "}
        <Button onClick={onDownload} disabled={!preview && !result}>
          Download recreate report
        </Button>
        {busy && <Spinner label="Working" />}
      </div>
      {preview && (
        <Table<{ leg: string; planned: number; skipped: number; error?: string }>
          columns={[
            { key: "leg", header: "Leg", render: (row) => row.leg },
            {
              key: "planned",
              header: "Planned",
              render: (row) => `${row.planned} planned`,
            },
            {
              key: "skipped",
              header: "Skipped",
              render: (row) => String(row.skipped),
            },
            {
              key: "status",
              header: "Status",
              render: (row) =>
                row.error ? (
                  <Badge tone="danger">{row.error}</Badge>
                ) : (
                  <Badge tone="neutral">preview</Badge>
                ),
            },
          ]}
          rows={[
            {
              leg: "D1",
              planned: preview.d1.selected.length,
              skipped: preview.d1.skipped.length,
            },
            ...preview.instances.map((i) => ({
              leg: i.login,
              planned: i.selected.length,
              skipped: i.skipped.length,
              ...(i.error ? { error: i.error } : {}),
            })),
          ]}
          rowKey={(row) => row.leg}
        />
      )}
      {preview && detailRows.length > 0 && (
        <div>
          <Button onClick={() => setDetailOpen((v) => !v)}>
            {detailOpen ? "Hide planned steps" : "Show planned steps"}
          </Button>
          {detailOpen && (
            <Table<DetailRow>
              columns={[
                { key: "leg", header: "Leg", render: (row) => row.leg },
                { key: "group", header: "Group", render: (row) => row.group },
                {
                  key: "code",
                  header: "Step",
                  render: (row) => <code>{row.code}</code>,
                },
                { key: "params", header: "Params", render: (row) => row.params },
              ]}
              rows={detailRows}
              rowKey={(row) => `${row.leg}:${row.group}:${row.code}:${row.params}`}
            />
          )}
        </div>
      )}
      {shownLayers.length > 0 && (
        <Table<{ layer: string; reason: string; remedy: string }>
          columns={[
            {
              key: "layer",
              header: "Cannot be recreated",
              render: (row) => <code>{row.layer}</code>,
            },
            { key: "reason", header: "Reason", render: (row) => row.reason },
            { key: "remedy", header: "Remedy", render: (row) => row.remedy },
          ]}
          rows={shownLayers}
          rowKey={(row) => row.layer}
        />
      )}
      {result && (
        <>
          <Notice tone={d1Failed > 0 ? "warning" : "success"}>
            Recreate complete — D1 leg executed {d1Executed} step(s)
            {d1Failed > 0 ? `, ${d1Failed} failed` : ""};{" "}
            {result.instances.length} instance leg(s) reported.
          </Notice>
          <Table<{ login: string; executed: number; failed: number; outcome: string; error?: string }>
            columns={[
              { key: "login", header: "Instance", render: (row) => row.login },
              {
                key: "executed",
                header: "Executed",
                render: (row) => String(row.executed),
              },
              {
                key: "failed",
                header: "Failed",
                render: (row) => String(row.failed),
              },
              {
                key: "outcome",
                header: "Outcome",
                render: (row) =>
                  row.error ? (
                    <Badge tone="danger">{row.error}</Badge>
                  ) : (
                    <Badge tone={row.outcome === "succeeded" ? "success" : "danger"}>
                      {row.outcome}
                    </Badge>
                  ),
              },
            ]}
            rows={result.instances.map((i) => ({
              login: i.login,
              executed: i.report?.executed.length ?? 0,
              failed: i.report?.failed.length ?? 0,
              outcome: i.report?.outcome ?? "error",
              ...(i.error ? { error: i.error } : {}),
            }))}
            rowKey={(row) => row.login}
          />
          <AuditLine audit={result.audit} />
        </>
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={scope === "tenant" ? "Confirm tenant recreate" : "Confirm platform recreate"}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={busy}>
              Keep data
            </Button>
            <Button
              onClick={() => void onConfirm()}
              disabled={!canConfirm || busy}
              variant="danger"
            >
              Confirm recreate
            </Button>
          </>
        }
      >
        <Stack gap="3">
          <p>
            This rebuilds the schema for exactly the previewed{" "}
            {scope === "tenant" ? `tenant (${tenantId})` : "platform"} scope —
            the confirm is bound to the preview token, so a scope that changed
            since the preview is refused by the server.
          </p>
          {scope === "platform" && (
            <TextInput
              label="Type the scope phrase to confirm"
              placeholder="CLEAN PLATFORM"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          )}
          <Checkbox
            label="I confirm the schema may be rebuilt in the member instances (auditConfirm)"
            checked={auditChecked}
            onChange={(e) => setAuditChecked(e.target.checked)}
          />
        </Stack>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Section composition
// ---------------------------------------------------------------------------

export function DataLifecyclePanel() {
  return (
    <Stack gap="4">
      <CleanStateCard />
      <PlatformBootstrapCard />
      <TenantBootstrapCard />
      <RecreateCard />
    </Stack>
  );
}
