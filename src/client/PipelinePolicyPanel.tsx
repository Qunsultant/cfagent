/**
 * Issue #4782 S3 — the pipeline-policy settings panel.
 *
 * A self-fetching panel (the NotificationPreferencesPanel pattern):
 * it reads the stored `pipeline.*` globals from
 * GET /api/trading/settings/pipeline-policy and writes through the
 * same route — the server is the only source of truth, so the panel
 * never keeps a second copy and never touches localStorage. A field
 * with no stored value shows the resolver's default; saving posts
 * only the fields the operator changed, and a refused value comes
 * back as a 400 naming the key, which the panel shows verbatim.
 *
 * The three parent poll intervals are env-configured, not
 * per-tenant settings (they feed shared-host loops — see #4782):
 * the panel shows their effective values read-only, with the env
 * lever named, rather than offering an edit that could not apply
 * per tenant.
 *
 * Renders only from src/client/components/ui/ primitives with
 * token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button, Card, Checkbox, Notice, Spinner, TextInput } from "./components/ui";
import {
  fetchPipelinePolicySettings,
  savePipelinePolicySettings,
} from "./pipelinePolicyApi";
import { getPollingConfig } from "./pollingConfig";
import { DEFAULT_CHAT_AWAIT_POLL_MS } from "../agents/orchestrator/chatAwaitBudget";

type FieldKind = "int" | "float" | "text" | "bool";

interface PolicyField {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
}

const RETRY_FIELDS: PolicyField[] = [
  { key: "attempts", label: "Attempts", kind: "int", hint: "1–10" },
  { key: "baseDelayMs", label: "Base delay (ms)", kind: "int" },
  { key: "maxDelayMs", label: "Max delay (ms)", kind: "int" },
  { key: "jitterRatio", label: "Jitter ratio", kind: "float", hint: "0–1" },
];

const BUCKETS: Array<{ id: string; label: string }> = [
  { id: "acquisition", label: "Acquisition" },
  { id: "delivery", label: "Delivery" },
  { id: "report", label: "Report" },
];

const NOTIFY_BOOL_FIELDS: PolicyField[] = [
  { key: "pipeline.notifications.enabled", label: "Notifications on", kind: "bool" },
  { key: "pipeline.notify.slack", label: "Slack", kind: "bool" },
  { key: "pipeline.notify.email", label: "Email", kind: "bool" },
  { key: "pipeline.notify.webhook", label: "Webhook", kind: "bool" },
];

export function PipelinePolicyPanel() {
  const [stored, setStored] = useState<Record<string, string> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchPipelinePolicySettings();
      setStored(data.settings);
      setDefaults(data.defaults);
      setDraft({});
      setDirty({});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load pipeline settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const valueFor = (key: string): string =>
    draft[key] ?? stored?.[key] ?? defaults[key] ?? "";

  const setValue = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty((prev) => ({ ...prev, [key]: true }));
    setSaved(false);
    setSaveError(null);
  };

  const save = async () => {
    const changed: Record<string, string> = {};
    for (const [key, isDirty] of Object.entries(dirty)) {
      if (isDirty) changed[key] = draft[key] ?? "";
    }
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const data = await savePipelinePolicySettings(changed);
      setStored(data.settings);
      setDefaults(data.defaults);
      setDraft({});
      setDirty({});
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save pipeline settings.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }

  if (loadError || stored === null) {
    return (
      <Card>
        <Notice tone="danger">
          Pipeline settings could not be loaded{loadError ? `: ${loadError}` : "."} The
          retry and notification tuning below is unavailable until the server answers.
        </Notice>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  const polling = getPollingConfig();
  const dirtyCount = Object.values(dirty).filter(Boolean).length;

  return (
    <Card>
      <div className="section-label-row">
        <span>Pipeline policy</span>
        <small>Retry budgets and notifications — per-tenant settings, effective on the next run</small>
      </div>

      {BUCKETS.map((bucket) => (
        <div key={bucket.id}>
          <div className="section-label-row">
            <span>{bucket.label} retries</span>
          </div>
          {RETRY_FIELDS.map((field) => {
            const key = `pipeline.retry.${bucket.id}.${field.key}`;
            return (
              <TextInput
                key={key}
                label={field.label}
                hint={field.hint}
                value={valueFor(key)}
                onChange={(event) => setValue(key, event.target.value)}
                inputMode="decimal"
                aria-label={`${bucket.label} ${field.label}`}
              />
            );
          })}
        </div>
      ))}

      <div className="section-label-row">
        <span>Shared overrides</span>
        <small>Apply to every bucket unless that bucket sets its own value</small>
      </div>
      {RETRY_FIELDS.map((field) => {
        const key = `pipeline.retry.${field.key}`;
        return (
          <TextInput
            key={key}
            label={field.label}
            hint={field.hint}
            value={valueFor(key)}
            onChange={(event) => setValue(key, event.target.value)}
            inputMode="decimal"
            aria-label={`Shared ${field.label}`}
          />
        );
      })}

      <div className="section-label-row">
        <span>Notifications</span>
      </div>
      {NOTIFY_BOOL_FIELDS.map((field) => (
        <Checkbox
          key={field.key}
          label={field.label}
          checked={valueFor(field.key) !== "0"}
          onChange={(event) => setValue(field.key, event.target.checked ? "1" : "0")}
          aria-label={field.label}
        />
      ))}
      <TextInput
        label="Events"
        hint="Comma-separated; prefix an event with - to silence it"
        value={valueFor("pipeline.notify.events")}
        onChange={(event) => setValue("pipeline.notify.events", event.target.value)}
        aria-label="Notification events"
      />
      <TextInput
        label="Fetch timeout (ms)"
        value={valueFor("pipeline.fetchTimeoutMs")}
        onChange={(event) => setValue("pipeline.fetchTimeoutMs", event.target.value)}
        inputMode="numeric"
        aria-label="Fetch timeout (ms)"
      />

      <div className="section-label-row">
        <span>Parent poll intervals (read-only)</span>
        <small>Env-configured — they feed shared-host loops, so they are not per-tenant settings</small>
      </div>
      <TextInput
        label="Screen-door parent poll (ms)"
        hint="SCREEN_DOOR_PARENT_POLL_MS"
        value={String(polling.screenDoorParentPollMs)}
        disabled
        aria-label="Screen-door parent poll (ms)"
      />
      <TextInput
        label="Chat-screen parent poll (ms)"
        hint="CHAT_SCREEN_PARENT_POLL_MS"
        value={String(polling.chatScreenParentPollMs)}
        disabled
        aria-label="Chat-screen parent poll (ms)"
      />
      <TextInput
        label="Chat-await poll default (ms)"
        hint="CHAT_AWAIT_POLL_MS — the default when the env lever is unset"
        value={String(DEFAULT_CHAT_AWAIT_POLL_MS)}
        disabled
        aria-label="Chat-await poll default (ms)"
      />

      {saveError && <Notice tone="danger">{saveError}</Notice>}
      {saved && <Notice tone="success">Pipeline settings saved — they apply to the next run.</Notice>}
      <Button type="button" variant="primary" loading={saving} disabled={dirtyCount === 0} onClick={() => void save()}>
        {dirtyCount === 0 ? "No changes" : `Save ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`}
      </Button>
    </Card>
  );
}
