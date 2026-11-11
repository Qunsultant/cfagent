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
 */
import type { Env } from "../types";
import type { SqlStorage } from "../orm";
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
} from "../trading";
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
}

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
  const capture = {
    sql: deps.sql,
    blobStorage: deps.blobStorage,
    env: deps.env,
    capturePort: deps.capturePort,
  };
  switch (def.sourceId) {
    case "yahoo":
      return createYahooDataProvider(
        new YahooFinanceProvider(deps.env),
        deps.env,
        { capture },
      );
    case "alpaca":
      return createAlpacaDataProvider(
        new AlpacaMarketDataProvider(deps.env),
        deps.env,
        { capture },
      );
    case "etrade":
      if (!deps.userLogin) return undefined;
      return createETradeDataProviderFromEnv(deps.env, deps.userLogin, {
        capture,
      });
    case "public":
      if (!deps.userLogin) return undefined;
      return createPublicDataProviderFromEnv(deps.env, deps.userLogin, {
        capture,
      });
    default:
      // "nasdaq" declares screenUniverse only — it has no feed
      // pull provider; its dataset is the stored index list.
      return undefined;
  }
}
