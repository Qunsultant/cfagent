/**
 * Issue #3535 (Pipeline J2) — the capture-wired provider factory
 * for feed jobs: ONE construction per source, shared by every
 * host that runs feed steps (the ScheduledAgent pipeline host
 * today; the data-providers route keeps its S1 Yahoo wiring,
 * which is this same construction for its host's storage).
 *
 * Every provider is built WITH the capture deps, so a feed fetch
 * lands in the capture log (raw + normalized, run-linked)
 * through the same write path screening's fetches use. A source
 * whose wiring cannot be built honestly on the calling host
 * resolves to undefined and the feed step refuses
 * FEED_JOB_NOT_CONFIGURED — a run is never fetched through an
 * unwired, uncaptured path.
 *
 * Login discipline: Yahoo and Alpaca are env-credentialed
 * (platform keys). E*TRADE and Public are per-login OAuth
 * providers — they are wired ONLY when the host carries a real
 * acting login (a copilot dispatch threads the chat user's; a
 * scheduled firing threads the platform's named service login
 * when configured). No login ⇒ no wiring ⇒ named refusal, never
 * another identity's credential.
 *
 * Issue #5494 (G7) — provider selection is no longer a
 * `switch (def.sourceId)`: the pair is resolved through ONE
 * capability lookup built on the #5515 vocabulary
 * (`resolveProviderDataset`, reading `providerDatasets` from
 * `config/vocabulary.json`), and a small builder registry answers
 * only "how is that provider constructed in this residency". So a
 * provider × dataset pair the matrix does not declare is REFUSED
 * BY NAME — it is never re-routed to another provider that happens
 * to serve the dataset (never broker-for-broker, #5515), and a new
 * pair is a data-only change.
 */
import type { Env } from "../types";
import type { SqlStorage } from "../orm";
import type { CircuitBreaker } from "../breakers/breakerPorts";
import type {
  CaptureBlobStorage,
  ProviderCaptureStore,
} from "../data/providerCapturePorts";
import {
  createAlpacaDataProvider,
  createETradeDataProviderFromEnv,
  createPublicDataProviderFromEnv,
  createYahooDataProvider,
  type DataProvider,
  type DataProviderId,
} from "../trading";
import { resolveProviderDataset } from "../config/vocabulary";
import {
  AlpacaMarketDataProvider,
  YahooFinanceProvider,
} from "./marketDataResearch";
import type { FeedJobDefinition } from "./feedJobs";

export interface FeedProviderWiringDeps {
  env: Env;
  /**
   * The host DO's SQLite (the capture deps' legacy-path handle).
   * Optional since #3941: the workflow residency has no DO
   * storage, so it wires through the capture port alone.
   */
  sql?: SqlStorage;
  /**
   * The residency's blob storage (the DO storage in agent
   * hosts; the R2-backed store in the workflow residency).
   * Required in every residency: a capture with nowhere to
   * record its metadata is a silent provenance gap.
   */
  blobStorage?: CaptureBlobStorage;
  /** The capture port (D1 in production); threads through every adapter. */
  capturePort?: ProviderCaptureStore | null;
  /** A real acting login for the per-login providers, when the host has one. */
  userLogin?: string;
  /**
   * Issue #5823 (#4437 slice 2): the Yahoo breaker (#1745), threaded
   * into the Yahoo adapter only. Feed jobs do not set it — a feed
   * pull behind the breaker would persist stale-cache rows as a
   * fresh capture; the screener's quote/history binds set it so a
   * screen during a Yahoo outage serves the stale cache instead of
   * failing the run. Absent ⇒ the raw provider, exactly as before.
   */
  yahooBreaker?: CircuitBreaker;
}

/**
 * The capture deps every feed adapter is constructed with. Present by the
 * factory's guard: a capture with nowhere to record its metadata is a silent
 * provenance gap, so the factory refuses before any builder runs.
 */
interface FeedCaptureWiring {
  sql: SqlStorage | undefined;
  blobStorage: CaptureBlobStorage;
  env: Env;
  capturePort: ProviderCaptureStore | null | undefined;
}

/**
 * How each provider is constructed in a residency — a registry keyed by the
 * platform provider id, not a selection switch. WHETHER a provider serves a
 * dataset is the matrix's decision (data, #5494); this map only knows the
 * constructor.
 *
 * A provider the matrix serves but this map does not build — the listings
 * provider, whose dataset is the stored universe job rather than a
 * capture-wired pull — resolves to undefined: a named refusal, never a
 * substitute.
 */
const FEED_PROVIDER_BUILDERS: Partial<
  Record<
    DataProviderId,
    (deps: FeedProviderWiringDeps, capture: FeedCaptureWiring) => DataProvider | undefined
  >
> = {
  yahoo: (deps, capture) =>
    createYahooDataProvider(new YahooFinanceProvider(deps.env), deps.env, {
      capture,
      // Issue #5823: the Yahoo breaker (#1745) rides only when
      // the caller supplied one (the screener's binds); feed
      // jobs pass none, so their provider is unchanged.
      ...(deps.yahooBreaker ? { breaker: deps.yahooBreaker } : {}),
    }),
  alpaca: (deps, capture) =>
    createAlpacaDataProvider(new AlpacaMarketDataProvider(deps.env), deps.env, {
      capture,
    }),
  etrade: (deps, capture) =>
    deps.userLogin
      ? createETradeDataProviderFromEnv(deps.env, deps.userLogin, { capture })
      : undefined,
  public: (deps, capture) =>
    deps.userLogin
      ? createPublicDataProviderFromEnv(deps.env, deps.userLogin, { capture })
      : undefined,
};

/**
 * Build the capture-wired provider for one feed job's source, or
 * undefined when this host cannot wire it honestly.
 */
export function createCaptureWiredFeedProvider(
  def: FeedJobDefinition,
  deps: FeedProviderWiringDeps,
): DataProvider | undefined {
  // #3941 (feed parity): the workflow residency has no DO sql
  // handle, so the capture port is its only row path — and the
  // metadata store is required in every residency. Refuse by
  // name when neither row path exists or when no metadata store
  // exists; never build a provider whose first capture write
  // would drop provenance silently.
  if ((!deps.capturePort && !deps.sql) || !deps.blobStorage) return undefined;
  // #5494 — the ONE capability lookup: the matrix decides whether this
  // provider serves this dataset at all. An unserved pair stops here; it is
  // never re-routed to a provider that does serve the dataset.
  const pair = resolveProviderDataset(def.sourceId, def.dataset);
  if (!pair.ok) return undefined;
  const build = FEED_PROVIDER_BUILDERS[pair.value.provider as DataProviderId];
  if (!build) return undefined;
  return build(deps, {
    sql: deps.sql,
    blobStorage: deps.blobStorage,
    env: deps.env,
    capturePort: deps.capturePort,
  });
}
