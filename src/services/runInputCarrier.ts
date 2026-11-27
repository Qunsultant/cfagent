/**
 * Issue #6682 — the one run-input carrier at dispatch.
 *
 * Every dispatch surface (Data Providers run, run_feed_job MCP/chat,
 * schedules, API) hands its run inputs to this module; the inputs are
 * validated by the existing spec binder and reach step params through
 * the existing spec builder as an ephemeral per-run definition — the
 * same bind → build → define sequence the define route uses, never a
 * second param path. Absent inputs return null: the job's own
 * definition runs exactly as before.
 *
 * Source selection is broker-neutral (#4894): a `sources` input names
 * the independent data-provider selection; the carrier resolves the
 * registered feed job for that provider + dataset and refuses by name
 * when none serves it. Provider construction still switches on the
 * resolved job's registered source — the carrier selects a job, it
 * never re-points a job at another provider.
 */
import { jobDefinitionSpec } from "../config/jobDefinitionCatalog";
import { FEED_PIPELINE_CATALOG } from "./feedPipelineJobs";
import { bindJobDefinitionParams, type JobDefinitionParams } from "./jobDefinitionParamBinders";
import { buildJobConfigFromSpec, type RawJobConfig } from "./jobDefinitionSpecBuilder";

export interface FeedRunInputDefinition {
  /** The registered feed job the run pulls (source-resolved). */
  targetJobId: string;
  /** The ephemeral per-run definition's job id. */
  ephemeralJobId: string;
  /** The bound run parameters the definition carries. */
  boundParams: JobDefinitionParams;
  config: RawJobConfig;
}

function hasInputs(inputs: JobDefinitionParams | undefined): inputs is JobDefinitionParams {
  return (
    inputs !== undefined &&
    Object.values(inputs).some((value) => value !== undefined && value !== null && value !== "")
  );
}

/**
 * Bind dispatch run inputs for one feed job into an ephemeral spec
 * definition. Returns null when no inputs were supplied (the caller
 * runs the job's own definition). Throws by name on undeclared or
 * invalid inputs and on a source/dataset pair no registered feed job
 * serves.
 */
export function buildFeedRunInputDefinition(
  jobId: string,
  inputs: JobDefinitionParams | undefined,
  owner: string | undefined,
): FeedRunInputDefinition | null {
  if (!hasInputs(inputs)) return null;
  const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
  if (!entry) {
    throw new Error(
      `Run inputs refused: job "${jobId}" is not a registered feed job, so it declares no run-input spec — inputs are never carried by an undeclared path.`,
    );
  }
  const { feedJobId: namedJobId, ...rest } = inputs;
  if (namedJobId !== undefined && namedJobId !== jobId) {
    throw new Error(
      `Run inputs refused: the inputs name feed job "${String(namedJobId)}" but the dispatch target is "${jobId}" — the job identity comes from the dispatch, never from an input.`,
    );
  }
  const spec = jobDefinitionSpec("feed");
  const bound = bindJobDefinitionParams(spec, { feedJobId: jobId, ...rest }, owner);

  // Source/dataset resolution: the bound selection names the job the
  // run pulls. One feed.pull stage pulls one job, so a multi-source
  // composing input refuses by name instead of silently narrowing.
  const dataset = typeof bound.dataset === "string" ? bound.dataset : entry.dataset;
  const sources = Array.isArray(bound.sources) ? (bound.sources as string[]) : [];
  if (sources.length > 1) {
    throw new Error(
      `Run inputs refused: sources [${sources.join(", ")}] name a composing run, but one feed.pull stage pulls one registered job — dispatch one run per source.`,
    );
  }
  let targetJobId = jobId;
  if (sources.length === 1 || bound.dataset !== undefined) {
    const sourceId = sources[0] ?? entry.sourceId;
    const target = FEED_PIPELINE_CATALOG.find(
      (e) => e.sourceId === sourceId && e.dataset === dataset,
    );
    if (!target) {
      throw new Error(
        `Run inputs refused: no registered feed job serves dataset "${dataset}" from source "${sourceId}" — the run is refused rather than pulling another provider's data.`,
      );
    }
    targetJobId = target.jobId;
  }
  const finalBound =
    targetJobId === jobId
      ? bound
      : bindJobDefinitionParams(spec, { feedJobId: targetJobId, ...rest }, owner);
  // The binder stamps the define-time trigger; a dispatch records its
  // own trigger on the run, so the ephemeral definition carries none.
  const { trigger: _defineTrigger, ...boundParams } = finalBound;
  const ephemeralJobId = `${targetJobId}:run:${Date.now().toString(36)}`;
  return {
    targetJobId,
    ephemeralJobId,
    boundParams,
    config: buildJobConfigFromSpec(spec, ephemeralJobId, boundParams),
  };
}
