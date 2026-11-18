/**
 * Issue #1743 — composition root for the observability ports.
 * This is the ONLY module that maps the Worker environment to
 * an observability sink: domain code imports this helper and
 * the port types, never a binding.
 *
 * Absence of the binding is a normal, non-error state:
 * unbound returns the console sink (local logging), exactly
 * the issue's degradation criterion — Analytics Engine
 * unavailability never fails the request. The in-memory
 * adapter is constructed explicitly by its users (tests,
 * local development), never here.
 *
 * Issue #5138 (S1 extension, observability program #5080) —
 * the destination switches: each destination (Analytics
 * Engine, console) is individually on/off, resolved through
 * the otelModes port (run > session > user > env > file >
 * builtin OFF; invalid fails closed to OFF with a coded
 * OBS-1001 message). AE off -> do not write to it (fall back
 * to console only if console is on; if both off, the event is
 * dropped — logging never fails the caller).
 *
 * Issue #5086 (S7) — the runtime flip: when the caller does
 * NOT pass explicit destinations, the sink resolves the
 * destinations PER WRITE from the runtime override cache
 * (destinations.analyticsEngine / destinations.console, the
 * `runtime` level, falling back to the deploy-time env/file
 * resolution) — so flipping a destination switch through the
 * admin UI applies on the next write, with no redeploy. The
 * adapters are built lazily and reused, so a flip from OFF to
 * ON can enable a destination at runtime. When the caller
 * DOES pass explicit destinations (a host that resolved with
 * full run/session/user scope), the host owns the resolution
 * and the sink keeps its construction-time behavior — the
 * runtime level must never override a run/session/user value
 * the host resolved. The OTel providers pass no explicit
 * destinations (they carry no run/session/user carriers in
 * production), so their sinks flip per write.
 *
 * Import direction, stated honestly: src/config/otelModes.ts
 * imports createObservabilitySink (its module logger), and
 * this module imports the destination resolver from otelModes.
 * The cycle is safe because otelModes' module logger is LAZY
 * (created on first use inside logInvalid, never at module top
 * level): no createObservabilitySink call happens during
 * otelModes' evaluation, so by the time the sink reads
 * OTEL_FILE_CONFIG (a const in otelModes), it is initialized.
 * This module likewise calls the resolver only inside
 * createObservabilitySink, never at module top level. The
 * runtime cache (src/config/otelConfigPort.ts) is read only
 * inside write(), never at module top level, so it adds no
 * import cycle: the port's chain (otelModes, otelMessages,
 * iaaaAudit) never imports this module.
 */
import { AnalyticsEngineObservabilityAdapter } from "./cfAnalyticsEngineAdapter";
import {
  OTEL_FILE_CONFIG,
  resolveOtelDestinationEnabled,
} from "../config/otelModes";
import {
  cachedOtelRuntimeOverrides,
  otelRuntimeLevel,
} from "../config/otelConfigPort";
import {
  ConsoleObservabilitySink,
  NoopObservabilitySink,
  SafeObservabilitySink,
  type ObservabilitySink,
} from "./observabilityPorts";

function asDataset(value: unknown): {
  writeDataPoint: (point: {
    indexes?: ((ArrayBuffer | string) | null)[];
    doubles?: number[];
    blobs?: ((ArrayBuffer | string) | null)[];
  }) => void;
} | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { writeDataPoint?: unknown }).writeDataPoint === "function"
  ) {
    return value as {
      writeDataPoint: (point: {
        indexes?: ((ArrayBuffer | string) | null)[];
        doubles?: number[];
        blobs?: ((ArrayBuffer | string) | null)[];
      }) => void;
    };
  }
  return null;
}

/**
 * Issue #5138 — the resolved destination switches a host
 * passes to the sink. Hosts that resolve with full scope
 * (run/session/user, e.g. the OTel composition root) pass
 * these; all other callers pass nothing and the sink resolves
 * from env + the config file (the levels available to it).
 */
export interface ObservabilityDestinations {
  analyticsEngine: boolean;
  console: boolean;
}

/** Build the observability sink from Worker env (always a sink, never null). */
export function createObservabilitySink(
  env: {
    OBSERVABILITY?: unknown;
    OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED?: unknown;
    OTEL_DESTINATION_CONSOLE_ENABLED?: unknown;
  },
  destinations?: ObservabilityDestinations,
): ObservabilitySink {
  // Explicit destinations: the host resolved them (full scope);
  // the sink keeps its construction-time behavior.
  if (destinations !== undefined) {
    const dataset = asDataset(env.OBSERVABILITY);
    if (destinations.analyticsEngine && dataset) {
      return new SafeObservabilitySink(
        new AnalyticsEngineObservabilityAdapter(dataset),
      );
    }
    if (destinations.console) return new ConsoleObservabilitySink();
    return new NoopObservabilitySink();
  }
  // No explicit destinations: resolve the deploy-time values
  // now, and the runtime overrides per write (S7).
  const deployTime: ObservabilityDestinations = {
    analyticsEngine: resolveOtelDestinationEnabled("analyticsEngine", {
      env: env.OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED,
      file: OTEL_FILE_CONFIG.destinations.analyticsEngine,
    }).enabled,
    console: resolveOtelDestinationEnabled("console", {
      env: env.OTEL_DESTINATION_CONSOLE_ENABLED,
      file: OTEL_FILE_CONFIG.destinations.console,
    }).enabled,
  };
  const dataset = asDataset(env.OBSERVABILITY);
  return new RuntimeDestinationsSink(dataset, deployTime);
}

/**
 * Issue #5086 (S7) — the sink that resolves destinations per
 * write. The runtime override (from the cache) wins over the
 * deploy-time value; the adapters are built lazily and reused,
 * so a flip can enable a destination at runtime. Never throws.
 */
class RuntimeDestinationsSink implements ObservabilitySink {
  private aeSink: SafeObservabilitySink | null = null;
  private consoleSink: ConsoleObservabilitySink | null = null;

  constructor(
    private readonly dataset: ReturnType<typeof asDataset>,
    private readonly deployTime: ObservabilityDestinations,
  ) {}

  private effective(): ObservabilityDestinations {
    const overrides = cachedOtelRuntimeOverrides();
    const ae = otelRuntimeLevel(overrides, "destinations.analyticsEngine");
    const console = otelRuntimeLevel(overrides, "destinations.console");
    return {
      analyticsEngine: typeof ae === "boolean" ? ae : this.deployTime.analyticsEngine,
      console: typeof console === "boolean" ? console : this.deployTime.console,
    };
  }

  write(event: Parameters<ObservabilitySink["write"]>[0]): void | Promise<void> {
    // The base sink is single-destination with AE primary and
    // console as fallback (the #5138 contract): AE when on and
    // bound, else console when on, else the event is dropped.
    // The per-write resolution only changes WHICH destination
    // is chosen, never the precedence.
    const destinations = this.effective();
    if (destinations.analyticsEngine && this.dataset) {
      if (!this.aeSink) {
        this.aeSink = new SafeObservabilitySink(
          new AnalyticsEngineObservabilityAdapter(this.dataset),
        );
      }
      return this.aeSink.write(event);
    }
    if (destinations.console) {
      if (!this.consoleSink) this.consoleSink = new ConsoleObservabilitySink();
      return this.consoleSink.write(event);
    }
    return undefined;
  }

  writeBatch(events: readonly Parameters<ObservabilitySink["write"]>[0][]): void | Promise<void> {
    const results: Array<void | Promise<void>> = [];
    for (const event of events) results.push(this.write(event));
    if (results.length === 0) return undefined;
    return Promise.all(results.map((r) => Promise.resolve(r))).then(() => undefined);
  }
}
