/**
 * Issue #5086 (S7, observability program #5080) — the Config
 * panel: the admin surface for the message catalog + the
 * runtime config port (`?tab=observability&view=config`).
 *
 * Every overridable key with its effective value and winning
 * source (runtime / env / file / builtin / catalog), editable
 * by a platform admin: each change is a versioned row in D1
 * with a required, audited reason, and clearing an override
 * restores the deploy-time value (a tombstone row — history
 * is kept). No redeploy: a flip applies on the next event for
 * domain gates and alerting, on the next operation for sink
 * destinations and the archive routes, and at the next
 * provider init for transport switches — the panel says so
 * plainly rather than promising instant everywhere.
 *
 * Composed from ui/ primitives (ADR-0004): Stack for layout,
 * Spinner for loading, Notice for the propagation note,
 * EmptyState for honest error states, Table for the rows,
 * Select / TextInput / Button for the per-key editor,
 * CardHeader for the section titles (no hand-rolled h3, #4913).
 * No bespoke className tokens, no inline styles, no CSS imports.
 */
import { useEffect, useState } from "react";
import {
  Button,
  CardHeader,
  EmptyState,
  Notice,
  Select,
  Spinner,
  Stack,
  Table,
  TextInput,
  type TableColumn,
} from "./components/ui";
import {
  applyOtelConfigOverride,
  clearOtelConfigOverride,
  fetchOtelConfig,
  type OtelCatalogEntry,
  type OtelConfigKeyDef,
  type OtelConfigOverride,
  type OtelConfigResponse,
  type OtelEffectiveEntry,
} from "./otelConfigApi";

/** Human-readable effective value (booleans read as on/off). */
export function formatEffectiveValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined) return "—";
  return String(value);
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: OtelConfigResponse };

const BOOLEAN_OPTIONS = ["true", "false"];
const EXPORTER_OPTIONS = ["otlp", "console", "none"];
const LEVEL_OPTIONS = ["ALL", "ERROR", "DEBUG", "INFO", "WARN", "TRACE", "OFF"];
const SEVERITY_OPTIONS = ["info", "warning", "error", "critical"];

/** Parses the editor's draft for one kind (null = not a value the server would accept). */
export function parseOtelConfigDraft(kind: OtelConfigKeyDef["kind"], draft: string): unknown {
  switch (kind) {
    case "boolean":
      return draft === "true" ? true : draft === "false" ? false : null;
    case "sampling":
    case "ratio":
    case "positiveInt":
    case "nonNegativeInt": {
      if (draft.trim() === "") return null;
      const parsed = Number(draft);
      return Number.isFinite(parsed) ? parsed : null;
    }
    default:
      return draft;
  }
}

function OtelConfigKeyEditor({
  def,
  effective,
  override,
  onChanged,
}: {
  def: OtelConfigKeyDef;
  effective: OtelEffectiveEntry | undefined;
  override: OtelConfigOverride | undefined;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    effective === undefined ? "" : String(effective.value),
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const value = parseOtelConfigDraft(def.kind, draft);
    if (value === null) {
      setError("Enter a valid value for this key.");
      return;
    }
    if (reason.trim() === "") {
      setError("A reason is required — every change is audited with its reason.");
      return;
    }
    setSaving(true);
    setError(null);
    void applyOtelConfigOverride(def.key, value, reason.trim())
      .then(() => onChanged())
      .catch((err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : "Failed to apply the override.");
      });
  };

  const clear = () => {
    if (reason.trim() === "") {
      setError("A reason is required — every change is audited with its reason.");
      return;
    }
    setSaving(true);
    setError(null);
    void clearOtelConfigOverride(def.key, reason.trim())
      .then(() => onChanged())
      .catch((err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : "Failed to clear the override.");
      });
  };

  const valueControl =
    def.kind === "boolean" ||
    def.kind === "exporter" ||
    def.kind === "level" ||
    def.kind === "severity" ? (
      <Select
        label={`New value for ${def.key}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={saving}
      >
        {(def.kind === "boolean"
          ? BOOLEAN_OPTIONS
          : def.kind === "exporter"
            ? EXPORTER_OPTIONS
            : def.kind === "level"
              ? LEVEL_OPTIONS
              : SEVERITY_OPTIONS
        ).map((option) => (
          <option key={option} value={option}>
            {def.kind === "boolean" ? (option === "true" ? "on" : "off") : option}
          </option>
        ))}
      </Select>
    ) : def.kind === "string" || def.kind === "protocol" ? (
      <TextInput
        label={`New value for ${def.key}`}
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={saving}
      />
    ) : (
      <TextInput
        label={`New value for ${def.key}`}
        type="number"
        inputMode="decimal"
        step={def.kind === "sampling" || def.kind === "ratio" ? "0.01" : "1"}
        min={def.kind === "positiveInt" ? "1" : "0"}
        max={def.kind === "sampling" || def.kind === "ratio" ? "1" : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={saving}
      />
    );

  return (
    <Stack gap="1">
      {valueControl}
      <TextInput
        label={`Reason for changing ${def.key}`}
        placeholder="Why this change? (required, audited)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        disabled={saving}
      />
      <div>
        <Button variant="secondary" size="sm" onClick={apply} loading={saving} disabled={reason.trim() === ""}>
          Apply
        </Button>{" "}
        {override ? (
          <Button variant="secondary" size="sm" onClick={clear} loading={saving} disabled={reason.trim() === ""}>
            Clear override
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Stack>
  );
}

interface ConfigKeyRow {
  def: OtelConfigKeyDef;
  effective: OtelEffectiveEntry | undefined;
  override: OtelConfigOverride | undefined;
}

export function OtelConfigPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = () => {
    setState({ status: "loading" });
    void fetchOtelConfig()
      .then((config) => setState({ status: "ready", config }))
      .catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load the OTel config.",
        });
      });
  };

  useEffect(() => {
    let cancelled = false;
    void fetchOtelConfig()
      .then((config) => {
        if (cancelled) return;
        setState({ status: "ready", config });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load the OTel config.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Stack>
        <Spinner label="Loading OTel config" />
        <p>Loading OTel config…</p>
      </Stack>
    );
  }

  if (state.status === "error") {
    const forbidden = /platform admins only/i.test(state.message);
    return (
      <EmptyState
        title={
          forbidden
            ? "The OTel config is available to platform admins only."
            : "The OTel config could not be loaded."
        }
        description={state.message}
      />
    );
  }

  const { config } = state;
  const overrideByKey = new Map(config.overrides.map((o) => [o.key, o]));
  const keyRows: ConfigKeyRow[] = config.keys
    .filter((def) => !def.key.startsWith("catalog."))
    .map((def) => ({
      def,
      effective: config.effective[def.key],
      override: overrideByKey.get(def.key),
    }));
  const catalogDefByCode = new Map(
    config.keys
      .filter((def) => def.key.startsWith("catalog."))
      .map((def) => [def.key, def]),
  );

  const keyColumns: TableColumn<ConfigKeyRow>[] = [
    {
      key: "key",
      header: "Key",
      render: (row) => (
        <>
          <strong>{row.def.key}</strong>
          <br />
          <small>{row.def.description}</small>
          {row.def.envName ? (
            <>
              <br />
              <small>{row.def.envName}</small>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: "effective",
      header: "Effective",
      render: (row) => formatEffectiveValue(row.effective?.value),
    },
    {
      key: "source",
      header: "Source",
      render: (row) => row.effective?.source ?? "—",
    },
    {
      key: "override",
      header: "Override",
      render: (row) =>
        row.override ? (
          <>
            v{row.override.version} · {row.override.updatedBy}
            <br />
            <small>
              {new Date(row.override.updatedAtMs).toLocaleString()} — {row.override.reason}
            </small>
          </>
        ) : (
          "—"
        ),
    },
    {
      key: "edit",
      header: "Change",
      render: (row) => (
        <OtelConfigKeyEditor
          key={`${row.def.key}:${row.override?.version ?? 0}`}
          def={row.def}
          effective={row.effective}
          override={row.override}
          onChanged={load}
        />
      ),
    },
  ];

  const catalogColumns: TableColumn<OtelCatalogEntry>[] = [
    {
      key: "code",
      header: "Code",
      render: (entry) => <strong>{entry.code}</strong>,
    },
    {
      key: "name",
      header: "Message",
      render: (entry) => (
        <>
          {entry.name}
          <br />
          <small>{entry.template}</small>
        </>
      ),
    },
    {
      key: "default",
      header: "Default severity",
      render: (entry) => entry.severity,
    },
    {
      key: "effective",
      header: "Effective severity",
      render: (entry) =>
        formatEffectiveValue(config.effective[`catalog.${entry.code}.severity`]?.value),
    },
    {
      key: "edit",
      header: "Change severity",
      render: (entry) => {
        const def = catalogDefByCode.get(`catalog.${entry.code}.severity`);
        if (!def) return "—";
        return (
          <OtelConfigKeyEditor
            key={`${def.key}:${overrideByKey.get(def.key)?.version ?? 0}`}
            def={def}
            effective={config.effective[def.key]}
            override={overrideByKey.get(def.key)}
            onChanged={load}
          />
        );
      },
    },
  ];

  return (
    <Stack gap="2">
      <p>
        The message catalog and the runtime config: every threshold, severity, retention,
        and sampling value in one place. A change here is a config edit, not a code
        change — it writes a versioned, audited row, and clearing an override restores
        the deploy-time value. No redeploy is needed.
      </p>
      <Notice tone="info">
        A flip applies on the next event for domain gates and alerting, on the next
        operation for sink destinations and the archive list, and at the next provider
        init for transport switches (master, exporters, batch, metrics/traces settings).
      </Notice>
      <CardHeader title="Switches, thresholds & sampling" />
      <Table<ConfigKeyRow>
        columns={keyColumns}
        rows={keyRows}
        rowKey={(row) => row.def.key}
        caption="Overridable OTel config keys with their effective values"
      />
      <CardHeader title="Message catalog" />
      <p>
        The single source for message text: every log, audit, alert, and trace event
        carries one of these codes. Codes are stable across releases and never reused
        for a different meaning.
      </p>
      <Table<OtelCatalogEntry>
        columns={catalogColumns}
        rows={config.catalog}
        rowKey={(entry) => entry.code}
        caption="The OTel message catalog with its severities"
      />
    </Stack>
  );
}
