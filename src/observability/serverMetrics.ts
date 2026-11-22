/**
 * Issue #5425 (#3515 S5) — the Worker fetch path's metrics
 * handle: one lazy per-isolate `createOtelMetrics` handle, so
 * the fetch path records API requests into the S2 recorder and
 * the SLO read endpoint evaluates through the SAME recorder.
 *
 * The pattern is the premiumQuota module-level cached handle
 * (src/services/premiumQuota.ts): create once per isolate,
 * never per request (a MeterProvider per request would leak a
 * periodic reader per request). A creation failure returns null
 * (the recording is a no-op) — metrics never fail a request.
 *
 * The handle's state is per-isolate, like every S2 host's:
 * each isolate evaluates the requests it served. Exports ride
 * the provider's 60s periodic reader while the isolate is warm.
 */
import type { Env } from "../types";
import { createOtelMetrics, type OtelMetricsHandle } from "./otelMetricsProvider";
import type { OtelMetricsRecorder } from "./otelMetricsRecorder";
import type { ApiRequestObservation } from "./aspects";

let serverOtelMetricsHandle: OtelMetricsHandle | null = null;

/** The fetch path's recorder (null when the handle could not be created). */
export function serverOtelMetricsRecorder(env: Env): OtelMetricsRecorder | null {
  try {
    if (!serverOtelMetricsHandle) serverOtelMetricsHandle = createOtelMetrics(env);
    return serverOtelMetricsHandle.recorder;
  } catch {
    return null;
  }
}

/**
 * Record one observed API request into the server metrics
 * handle. Best-effort: never throws, never fails the request.
 */
export function recordServerApiRequest(env: Env, observation: ApiRequestObservation): void {
  try {
    serverOtelMetricsRecorder(env)?.recordApiRequest(observation);
  } catch {
    // Best-effort: recording never fails the request.
  }
}
