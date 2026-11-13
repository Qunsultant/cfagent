/**
 * Issue #4366 ([Stage visibility] UX workflow-definition + scheduling flow)
 * — the definition reads/writes behind the UX.
 *
 *   GET  /api/job-definitions                 the externalized catalogue
 *   POST /api/job-definitions/:id/define      define an engine job from a spec
 *
 * Defining is the first half of the flow; the second half is the schedule
 * itself, created through the existing `POST /api/schedules` with the
 * callback `runPipelineJobSchedule` (the Orchestrator host method that runs
 * one engine job). Reusing that path means the UX flow schedules through the
 * same alarm machinery every other schedule uses.
 */
import { jobDefinitionSpec, listJobDefinitionSpecs, type JobDefinitionSpec } from "../../config/jobDefinitionCatalog";
import { UNIVERSES } from "../../trading";

export interface JobDefinitionDefineResult {
  jobId: string;
  name: string;
  version: number;
  stages: number;
}

export interface JobDefinitionsRouteContext {
  /** The catalogue; defaults to the built-in specs. */
  readDefinitions?: () => JobDefinitionSpec[];
  /** Define the job on the ScheduledAgent; absent = named 503. */
  defineJobFromSpec?: (
    specId: string,
    jobId: string,
    params: Record<string, unknown>,
  ) => Promise<JobDefinitionDefineResult>;
}

const DEFINE_PATH = /(?:^|\/api)\/job-definitions\/([^/]+)\/define$/;
const LIST_PATH = /(?:^|\/api)\/job-definitions$/;

/**
 * Fill a select parameter's options from the registry that owns them
 * (today: the universe ids), so the client never hard-codes a list.
 */
function withSelectOptions(spec: JobDefinitionSpec): JobDefinitionSpec {
  const parameters = spec.parameters?.map((param) => {
    if (param.type !== "select" || (param.options && param.options.length > 0)) return param;
    if (param.name === "universe") return { ...param, options: Object.keys(UNIVERSES) };
    return param;
  });
  return parameters ? { ...spec, parameters } : spec;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function handleJobDefinitionsRoutes(
  request: Request,
  url: URL,
  path: string,
  ctx: JobDefinitionsRouteContext,
): Promise<Response | null> {
  const defineMatch = DEFINE_PATH.exec(path);
  const listMatch = defineMatch ? null : LIST_PATH.exec(path);
  if (!defineMatch && !listMatch) return null;

  if (listMatch) {
    if (request.method !== "GET") return null;
    const definitions = (ctx.readDefinitions ?? listJobDefinitionSpecs)().map(withSelectOptions);
    return Response.json({ count: definitions.length, definitions });
  }

  if (request.method !== "POST") return null;
  const specId = decode(defineMatch![1]);
  let spec: JobDefinitionSpec;
  try {
    spec = jobDefinitionSpec(specId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
  if (!ctx.defineJobFromSpec) {
    return Response.json(
      { error: `Defining job "${specId}" is unavailable: this surface has no pipeline host.` },
      { status: 503 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // An empty body is allowed: the caller may rely on the spec's defaults.
  }
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!jobId) {
    return Response.json(
      {
        error: `Defining the "${specId}" job requires a jobId in the body — one is never invented.`,
      },
      { status: 400 },
    );
  }
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  try {
    const defined = await ctx.defineJobFromSpec(spec.id, jobId, params);
    return Response.json({
      ...defined,
      specId: spec.id,
      specVersion: spec.version,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /is invalid|must be|requires/.test(message) ? 400 : 503;
    return Response.json({ error: message, specId }, { status });
  }
}
