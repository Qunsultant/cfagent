# Decision: one message catalog + one config port (S7, #5086)

- **Issue:** [cfagent #5086](https://github.com/Qunsultant/cfagent/issues/5086) — S7, observability program #5080
- **Status:** Implemented (PR merges this slice; see CHANGELOG `## [Unreleased]`)
- **Date:** 2026-11-18
- **Owner:** #CISO-bhdm (lane payrepo)

## Context

Before S7, thresholds, severities, retention, and sampling were
hard-coded or per-caller across the telemetry slices, and
log/audit/alert text was free-form. The owner directive of
2026-11-12 says no hard-coding: every default, constant, and
setting must be externalized and configurable. The telemetry
taxonomy (AGENTS.md) already required every event to carry a
stable coded message from one catalog — but no single catalog
existed, and the S4 alerting port shipped with placeholder rules
only (owner decision, S7 option b: the real catalog lands with
S7). The S1 deploy-time config (env vars + `config/otel.json`)
could only change with a redeploy; the runtime flip
(no-redeploy) was S7's job.

## Decision

**One message catalog** (`src/observability/otelMessages.ts`,
`OBS_CATALOG`): 23 codes, OBS-1001..OBS-1023, each with a
human-readable template and a default severity
(info | warning | error | critical). Codes are stable across
releases and never reused for a different meaning. The catalog
is the single source for message text — `formatCatalogMessage`
is the only formatter (`formatOtelMessage` deleted); a lookup
by an unknown code misses and fails closed, never silently
passing. The pre-existing codes are absorbed unchanged
(S1 OBS-1001; S2 OBS-1006/1007; S3 OBS-1012/1013; S4
OBS-1014..1019; S6 OBS-1020; archive OBS-1008..1011); S7 adds
OBS-1021 (unknown alert rule, rejected) and OBS-1022 (config
forbidden); #6112 adds OBS-1023 (audit-chain append failed,
named instead of vanishing silently). Per-code severity overrides ride the config port
(`catalog.<OBS-code>.severity`), generated from the catalog
itself — adding a code automatically makes its severity
overridable.

**One config port** (`src/config/otelConfigPort.ts`): ALL
thresholds, severities, retention, sampling, and the catalog
live in config. The runtime override store is **D1**
(`AGENT_DB`, table `otel_config_overrides`, migration 0070),
read by the Worker at runtime through a 60s-TTL cache
(stale-while-revalidate). Versioned, auditable, reversible —
the #2838 / #2842 treatment: the table is append-only, every
change INSERTs a new versioned row (actor + timestamp +
reason), clearing INSERTs a tombstone row (value NULL), and
every change also writes a `recordAuditEvent` audit event.
Revert = apply an earlier version's value as a new version.
Only keys on the allow-list (`otelRuntimeOverrideKeys()`)
can be overridden; an unknown key or invalid value is
rejected at write time, never stored; a reason is required
for every change. Resolution is run > session > user >
**runtime** > env > file > built-in safe default (invalid
fails closed to OFF with a coded OBS-1001 message + audit).

## Alternatives considered

- **KV for the runtime store.** Rejected: no KV namespace is
  provisioned for this Worker; adding one is an owner
  provisioning step. D1 (`AGENT_DB`) is already bound and
  reachable from every context that has `env`.
- **DO SQLite settings store (`mas_settings`).** Rejected:
  DO SQL lives inside a Durable Object; a Worker isolate
  cannot read it directly, so the config port would need a
  DO RPC hop on every read. D1 is reachable from every
  context.
- **Env-only (no runtime store).** Rejected: it cannot flip
  without a redeploy, which is the requirement S7 exists to
  meet.
- **A second config catalog for the port.** Rejected: the
  port IS the config catalog; the allow-list is generated
  from the message catalog for severity keys, so there is
  exactly one list.

## What S7 wires

- **Alerting (S4):** the placeholder rules now resolve
  through the catalog — `rule:stuck-run` → OBS-1017,
  `rule:cap-breach` → OBS-1018, `rule:ci-failure` →
  OBS-1019. An unknown non-placeholder rule is rejected
  with OBS-1021, sends nothing, consumes no guard budget.
  Placeholder rules still deliver, unchanged.
- **Sinks:** `createObservabilitySink` resolves destinations
  per write from env/file + the override cache
  (AE-primary / console-fallback precedence preserved).
- **Gates:** the domain gates consult the cache per event;
  `isDomainEnabled` kicks off a TTL-guarded background
  refresh. The logging/metrics/traces providers read the
  runtime level at init and stop passing explicit
  destinations to the sinks.
- **Archive routes:** the R2 switch + page size / max
  objects resolve per request from the refreshed cache.
- **Catalog text migration:** 29 call sites in
  otelArchive / otelIngestion / otelLogs / otelMetrics /
  otelTraces / the archive route / the S6 namer moved to
  `formatCatalogMessage`; zero `formatOtelMessage` remains.
- **Admin surface:** `GET / POST / DELETE
  /api/otel/v1/config` (platform-admin only, OBS-1022 on
  403) and `?tab=observability&view=config`
  (`OtelConfigPanel`): catalog + key allow-list + overrides
  + the effective value and winning source for every key.

## Propagation contract (honest)

The override is READ at runtime (no redeploy). It takes
effect on the next operation for the alerting port (per
alert), the structured-logger sink destinations (per write),
and the archive routes (per request); on the next event for
domain on/off/level/sampling (gates + `isDomainEnabled`
consult the cache per call); at the next provider/control
init for the master switch, exporters, batch, and
metrics/traces transport settings. The admin write route
force-refreshes the writing isolate's cache; other isolates
pick the flip up within the 60s TTL or on their next
alert/admin request.

## Import-cycle note (a real bug caught by tests)

The port sits in the otelModes ↔ observability import cycle
(otelModes imports `createObservabilitySink`, which imports
the port, which imports otelModes). The allow-list was first
built at module top level and threw `OTEL_DOMAINS is not
iterable` whenever otelModes was still evaluating
(caught by `tests/otel_config_5081.test.ts`). The list is now
built lazily on first use (`otelRuntimeOverrideKeys()`); the
port's module top level has no side effects.

## Consequences / residuals

- Changing a severity or threshold is now a config edit, not
  a code change (proven by `tests/otel_config_routes_5086.test.ts`:
  POST moves the effective value and its source to `runtime`).
- The S4 consumers, the S6 namer, and the archive route now
  speak catalog codes; no slice invents its own codes
  (#3765 S1/S2 consume the catalog when they build).
- The Audit Vault (`?tab=audit-vault`) still reads
  `mas_events`, not the canonical IAAA audit store — that is
  #5264's decision, untouched by this slice.
- The dashboard's display of codes is S8 (#5087), out of
  scope here.
- S6's residuals (no `job_run_records` DO→D1 projector;
  goal-run sites not wiring the namer) are untouched.
