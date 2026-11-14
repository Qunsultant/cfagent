/**
 * Issue #4366 — the UX workflow-definition + scheduling flow.
 *
 * Lists the externalized definition specs (GET /api/job-definitions) with
 * their stages, mode and the parameters they require, and schedules one:
 * define the engine job from the spec + the collected parameters
 * (POST /api/job-definitions/:id/define), then arm a unified schedule whose
 * callback runs that job (`runPipelineJobSchedule`) through the existing
 * POST /api/schedules/create path — the same alarm machinery every other
 * schedule uses, no second scheduler.
 *
 * Every mutation carries the CSRF header (`csrfHeaders`) — the cookie-
 * authenticated route refuses a mutation without it.
 *
 * A definition is only scheduled after it validates and its required
 * parameters are supplied; a failure names the reason and leaves nothing
 * armed. ui/ primitives only, tokens only.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Modal, Notice, Select, Stack, TextInput } from "./components/ui";
import { csrfHeaders } from "./apiFetch";
import { JOB_DEFINITION_SCHEDULE_CALLBACK, jobIdForSpec } from "../config/jobDefinitionScheduling";

interface DefinitionParameter {
  name: string;
  label: string;
  type: "select" | "text" | "number";
  required?: boolean;
  description?: string;
  options?: string[];
}

interface StageSpec {
  kind: string;
  step: string;
  parameters?: DefinitionParameter[];
  executionMode?: Record<string, string>;
}

interface DefinitionSpec {
  id: string;
  name: string;
  version: number;
  description?: string;
  stages: StageSpec[];
  executionMode?: Record<string, string>;
  parameters?: DefinitionParameter[];
}

const MODE_AXES: ReadonlyArray<{ key: string; label: string; options: string[] }> = [
  { key: "concurrency", label: "Concurrency", options: ["sequential", "parallel"] },
  { key: "pacing", label: "Pacing", options: ["batch", "online"] },
  { key: "delivery", label: "Delivery", options: ["sync", "async"] },
  { key: "shape", label: "Shape", options: ["monolith", "sharded"] },
];

const STAGE_CADENCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "15", label: "Every 15 minutes" },
  { id: "60", label: "Hourly" },
  { id: "360", label: "Every 6 hours" },
  { id: "1440", label: "Daily" },
];

const CADENCES: ReadonlyArray<{ id: string; label: string; intervalSeconds: number }> = [
  { id: "15m", label: "Every 15 minutes", intervalSeconds: 15 * 60 },
  { id: "1h", label: "Hourly", intervalSeconds: 60 * 60 },
  { id: "6h", label: "Every 6 hours", intervalSeconds: 6 * 60 * 60 },
  { id: "daily", label: "Daily", intervalSeconds: 24 * 60 * 60 },
];

export function WorkflowDefinitionFlow() {
  const [definitions, setDefinitions] = useState<DefinitionSpec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<DefinitionSpec | null>(null);
  const [jobId, setJobId] = useState("");
  const [cadence, setCadence] = useState("1h");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [stageModes, setStageModes] = useState<Record<string, Record<string, string>>>({});
  const [stageParams, setStageParams] = useState<Record<string, Record<string, string>>>({});
  const [stageSchedules, setStageSchedules] = useState<
    Record<string, { intervalMinutes?: number; cron?: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<{ jobId: string; intervalSeconds: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/job-definitions", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload = (await res.json()) as { definitions?: DefinitionSpec[] };
        if (!cancelled) setDefinitions(Array.isArray(payload.definitions) ? payload.definitions : []);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setDefinitions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const intervalSeconds = useMemo(
    () => CADENCES.find((c) => c.id === cadence)?.intervalSeconds ?? 60 * 60,
    [cadence],
  );

  const missingRequired = (target?.parameters ?? []).filter(
    (param) => param.required && !String(paramValues[param.name] ?? "").trim(),
  );

  const open = (spec: DefinitionSpec) => {
    setTarget(spec);
    setJobId(jobIdForSpec(spec.id));
    setCadence("1h");
    setParamValues({});
    setStageModes({});
    setStageParams({});
    setStageSchedules({});
    setActionError(null);
    setScheduled(null);
  };

  const schedule = async () => {
    if (!target) return;
    setBusy(true);
    setActionError(null);
    try {
      const defined = await fetch(`/api/job-definitions/${encodeURIComponent(target.id)}/define`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...csrfHeaders(),
        },
        body: JSON.stringify({ jobId, params: paramValues, stageModes, stageParams, stageSchedules }),
      });
      const definedBody = (await defined.json().catch(() => ({}))) as { error?: string };
      if (!defined.ok) {
        throw new Error(definedBody.error || `Defining the job failed (${defined.status}).`);
      }
      const armed = await fetch("/api/schedules/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...csrfHeaders(),
        },
        body: JSON.stringify({
          scheduleType: "interval",
          intervalSeconds,
          callback: JOB_DEFINITION_SCHEDULE_CALLBACK,
          payload: { jobId },
        }),
      });
      const armedBody = (await armed.json().catch(() => ({}))) as { error?: string };
      if (!armed.ok) {
        throw new Error(armedBody.error || `Arming the schedule failed (${armed.status}).`);
      }
      setScheduled({ jobId, intervalSeconds });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <Stack gap="3">
        <strong>Workflow definitions</strong>
        <span>Define a job from its spec and schedule it</span>
        <Notice tone="warning" density="compact" title="Stage cadences">
          A stage cadence is a separate schedule for that stage. Until the host re-declares its
          scheduled tasks (the dynamic-declaration follow-up), a stage cadence on a newly defined job
          takes effect at the host&apos;s next declaration; the job&apos;s own cadence is armed
          immediately.
        </Notice>
        <Notice tone="info" density="compact">
          Every definition is validated before it is defined: a spec with an unknown stage, a
          missing step or an invalid mode refuses by name, a required parameter with no value
          refuses by name, and nothing is scheduled.
        </Notice>
        {loadError && (
          <Notice tone="warning" density="compact" title="Definitions unavailable">
            {loadError}
          </Notice>
        )}
        {(definitions ?? []).map((spec) => (
          <Card key={spec.id} padding="sm">
            <Stack gap="2">
              <strong>{spec.name}</strong>
              <span>{`${spec.id} · v${spec.version}`}</span>
              <div>
                {spec.stages.map((stage) => (
                  <Badge key={`${spec.id}-${stage.kind}`} tone="neutral" size="sm">
                    {stage.kind}
                  </Badge>
                ))}
              </div>
              {spec.executionMode && <span>{Object.values(spec.executionMode).join(" · ")}</span>}
              {spec.description && <span>{spec.description}</span>}
              <Button variant="secondary" size="sm" onClick={() => open(spec)}>
                Schedule this definition
              </Button>
            </Stack>
          </Card>
        ))}
        {definitions !== null && definitions.length === 0 && !loadError && (
          <Notice tone="warning" density="compact">
            No workflow definitions are configured in this deployment.
          </Notice>
        )}
      </Stack>

      {target && (
        <Modal open onClose={() => setTarget(null)} title={`Schedule ${target.name}`}>
          <Stack gap="3">
            <div>
              <span>Job id</span>
              <TextInput
                aria-label="Job id"
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
              />
            </div>
            {(target.parameters ?? []).map((param) => (
              <div key={param.name}>
                <span>{param.label}</span>
                {param.type === "select" ? (
                  <Select
                    aria-label={param.label}
                    value={paramValues[param.name] ?? ""}
                    onChange={(event) =>
                      setParamValues((current) => ({ ...current, [param.name]: event.target.value }))
                    }
                  >
                    <option value="">Select…</option>
                    {(param.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    aria-label={param.label}
                    value={paramValues[param.name] ?? ""}
                    onChange={(event) =>
                      setParamValues((current) => ({ ...current, [param.name]: event.target.value }))
                    }
                  />
                )}
                {param.description && <span>{param.description}</span>}
              </div>
            ))}
            {(target.stages ?? []).map((stage) => (
              <div key={`${target.id}-${stage.kind}-mode`}>
                <span>{`${stage.kind} — execution mode`}</span>
                {MODE_AXES.map((axis) => (
                  <Select
                    key={axis.key}
                    aria-label={`${stage.kind} ${axis.label}`}
                    value={stageModes[stage.kind]?.[axis.key] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setStageModes((current) => {
                        const axes = { ...(current[stage.kind] ?? {}) };
                        if (value) axes[axis.key] = value;
                        else delete axes[axis.key];
                        const next = { ...current };
                        if (Object.keys(axes).length > 0) next[stage.kind] = axes;
                        else delete next[stage.kind];
                        return next;
                      });
                    }}
                  >
                    <option value="">{`${axis.label}: inherit`}</option>
                    {axis.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                ))}
                <div>
                  <span>{`${stage.kind} — cadence`}</span>
                  <Select
                    aria-label={`${stage.kind} cadence`}
                    value={
                      stageSchedules[stage.kind]?.cron
                        ? "cron"
                        : stageSchedules[stage.kind]?.intervalMinutes !== undefined
                          ? String(stageSchedules[stage.kind]!.intervalMinutes)
                          : ""
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setStageSchedules((current) => {
                        const next = { ...current };
                        if (!value) delete next[stage.kind];
                        else if (value === "cron") next[stage.kind] = { cron: "" };
                        else next[stage.kind] = { intervalMinutes: Number(value) };
                        return next;
                      });
                    }}
                  >
                    <option value="">No separate cadence</option>
                    {STAGE_CADENCES.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                    <option value="cron">Custom cron (UTC)</option>
                  </Select>
                  {stageSchedules[stage.kind]?.cron !== undefined && (
                    <TextInput
                      aria-label={`${stage.kind} cron`}
                      value={stageSchedules[stage.kind]?.cron ?? ""}
                      onChange={(event) =>
                        setStageSchedules((current) => ({
                          ...current,
                          [stage.kind]: { cron: event.target.value },
                        }))
                      }
                    />
                  )}
                </div>
                {(stage.parameters ?? []).map((param) => (
                  <TextInput
                    key={param.name}
                    aria-label={`${stage.kind} ${param.label}`}
                    value={stageParams[stage.kind]?.[param.name] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setStageParams((current) => ({
                        ...current,
                        [stage.kind]: { ...(current[stage.kind] ?? {}), [param.name]: value },
                      }));
                    }}
                  />
                ))}
              </div>
            ))}
            <div>
              <span>Cadence</span>
              <Select
                aria-label="Cadence"
                value={cadence}
                onChange={(event) => setCadence(event.target.value)}
              >
                {CADENCES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            {actionError && (
              <Notice tone="danger" density="compact">
                {actionError}
              </Notice>
            )}
            {scheduled && (
              <Notice tone="success" density="compact" title="Scheduled">
                Job <code>{scheduled.jobId}</code> is armed every{" "}
                {Math.round(scheduled.intervalSeconds / 60)} minutes. Its runs appear in Workflow
                Runs with per-stage status and times.
              </Notice>
            )}
            <Button
              variant="primary"
              onClick={() => void schedule()}
              loading={busy}
              disabled={busy || !jobId.trim() || missingRequired.length > 0}
            >
              Define &amp; schedule
            </Button>
            {missingRequired.length > 0 && (
              <span>{`Required: ${missingRequired.map((param) => param.label).join(", ")}`}</span>
            )}
          </Stack>
        </Modal>
      )}
    </Card>
  );
}
