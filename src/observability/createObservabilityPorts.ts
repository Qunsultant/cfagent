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
 * Import direction, stated honestly: src/config/otelModes.ts
 * imports createObservabilitySink (its module logger), and
 * this module imports the destination resolver from otelModes.
 * The cycle is safe because otelModes' module logger is LAZY
 * (created on first use inside logInvalid, never at module top
 * level): no createObservabilitySink call happens during
 * otelModes' evaluation, so by the time the sink reads
 * OTEL_FILE_CONFIG (a const in otelModes), it is initialized.
 * This module likewise calls the resolver only inside
 * createObservabilitySink, never at module top level.
 */
import { AnalyticsEngineObservabilityAdapter } from "./cfAnalyticsEngineAdapter";
import {
  OTEL_FILE_CONFIG,
  resolveOtelDestinationEnabled,
} from "../config/otelModes";
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
  const resolved: ObservabilityDestinations =
    destinations ??
    {
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
  if (resolved.analyticsEngine && dataset) {
    return new SafeObservabilitySink(
      new AnalyticsEngineObservabilityAdapter(dataset),
    );
  }
  if (resolved.console) return new ConsoleObservabilitySink();
  return new NoopObservabilitySink();
}
