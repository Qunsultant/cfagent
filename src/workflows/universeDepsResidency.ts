/**
 * Issue #4473 — resolve live universe deps from a run's universe
 * stage input, in the workflow residency.
 *
 * The resolving steps hand the run's decoded universe descriptor
 * here; the factory rebuilds live {@link NasdaqUniverseDeps} per
 * invocation over the D1 data-provider ports (config + capture),
 * with NO SqlStorage handle — the workflow residency has none, so
 * the route bundle runs its ports-only path
 * (`nasdaqUniverseRouteBundle` with both ports, no sql). The
 * descriptor is the only thing that travels on the run; the live
 * deps are rebuilt here, per stage step, and never stored.
 *
 * Capture follows the established split, decided from the
 * bindings rather than the input: when the R2 capture blob store
 * is bound (REPORTS_BUCKET), the adapter captures full blobs;
 * when it is not, outcomes only — the same split the call-site
 * builders (the firer, the evaluate route) apply from their own
 * storage handles. The run context attributes captures/outcomes
 * to the ENGINE run id, the acting login, and the descriptor's
 * tenant (defaulting to `"default"` in the bundle, as the
 * call-site builders do).
 *
 * Refusals are `stage_port_unavailable` with the reason named:
 * unbound D1 ports (AGENT_DB), a route that does not name nasdaq,
 * a disabled nasdaq provider, or any bundle failure wrapped with
 * its underlying message. No logging: the error carries the
 * reason, and the engine records it on the step.
 *
 * Server-only: the resolving steps import the factory's seam
 * (the `universeDepsFor` callback) rather than this module, and
 * the workflow wiring binds it — the module's graph reaches the
 * D1 adapters and the report pipeline's capture path, which the
 * client bundle must not hold (the #4066 discipline, same as
 * `./manualOptionsResidency`).
 */
import { buildDataProviderPorts } from "../data/buildDataProviderPorts";
import type { ProviderConfigStore } from "../data/providerConfigPorts";
import type {
  CaptureBlobStorage,
  ProviderCaptureStore,
} from "../data/providerCapturePorts";
import { createR2CaptureBlobStorage } from "../data/r2CaptureBlobAdapter";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import type { Env } from "../types";
import {
  bindNasdaqUniverseDeps,
  nasdaqUniverseProviderFromRoute,
  nasdaqUniverseRouteBundle,
  type NasdaqUniverseDeps,
} from "../trading";
import {
  OptionsStepPortsError,
  type UniverseDepsStageInput,
} from "./optionsStepPorts";

/** The D1 ports the factory resolves over — the pair, or neither. */
export interface UniverseDepsResidencyPorts {
  config: ProviderConfigStore | null;
  captures: ProviderCaptureStore | null;
}

export interface ResolveUniverseDepsFromStageInputArgs {
  userLogin?: string;
  runId: string;
  universe: UniverseDepsStageInput;
}

export interface ResolveUniverseDepsFromStageInputOpts {
  /** Injected ports (tests); omitted, built from env (AGENT_DB → D1 adapters, unbound → nulls). */
  ports?: UniverseDepsResidencyPorts | null;
  /** Override listings fetcher (tests); omitted, the adapter's live feed fetcher. */
  fetchListings?: () => Promise<NasdaqStockListing[]>;
  /**
   * Capture blob storage. Omitted, the R2 adapter (null when
   * REPORTS_BUCKET is unbound → outcome-only). Explicit null →
   * outcome-only even when the bucket is bound (tests).
   */
  blobStorage?: CaptureBlobStorage | null;
}

export async function resolveUniverseDepsFromStageInput(
  env: Env,
  args: ResolveUniverseDepsFromStageInputArgs,
  opts: ResolveUniverseDepsFromStageInputOpts = {},
): Promise<NasdaqUniverseDeps> {
  const ports =
    opts.ports !== undefined ? opts.ports : await buildDataProviderPorts(env);
  if (!ports?.config || !ports?.captures) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${args.runId}: the universe stage input names provider "${args.universe.provider}" but the workflow residency has no D1 data-provider ports — AGENT_DB is unbound, so the universe deps cannot be resolved; bind AGENT_DB or dispatch without the universe input`,
    );
  }
  const blobStorage =
    opts.blobStorage !== undefined
      ? opts.blobStorage
      : createR2CaptureBlobStorage(env);
  try {
    const bundle = await nasdaqUniverseRouteBundle({
      env,
      // No acting login rides some dispatches; the run context
      // carries an empty login then, and the owner-scoped stages
      // refuse later as they do today.
      userLogin: args.userLogin ?? "",
      runId: args.runId,
      ...(args.universe.tenantId ? { tenantId: args.universe.tenantId } : {}),
      ...(blobStorage ? { storage: blobStorage } : {}),
      configPort: ports.config,
      capturePort: ports.captures,
      ...(opts.fetchListings ? { fetchListings: opts.fetchListings } : {}),
    });
    const provider = nasdaqUniverseProviderFromRoute(
      bundle.registry,
      bundle.configs,
      bundle.routes,
    );
    return bindNasdaqUniverseDeps(provider, bundle.runContext);
  } catch (err) {
    if (err instanceof OptionsStepPortsError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${args.runId}: universe deps for provider "${args.universe.provider}" could not be resolved — ${reason}`,
    );
  }
}
