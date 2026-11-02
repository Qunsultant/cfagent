/**
 * Phase 5 Slice 3 (issue #2000) — the mesh trace surfacing
 * route (mirrors src/data/shardJobRoute.ts).
 *
 * GET /api/traces?traceId= : the read surface for the mesh
 * trace spine. Before this slice no route exposed hopsFor —
 * the assembly existed only behind the MCP read command.
 *
 * Pure handler: no env, no binding, no store client. The
 * server wires it to the composition root; the handler
 * decides only status codes and response shape.
 *
 * Decision order: 401 (no wired session) → 405 (non-GET) →
 * 400 (missing/malformed traceId — refused, never normalized
 * into a lookup) → 503 (reader reports the store unbound) →
 * 404 (no hops survive the tenant filter) → 200 (assembly).
 *
 * Tenancy mirrors the MCP read surface (traceForMcp): hops
 * recorded under a DIFFERENT tenant are excluded before
 * assembly; a hop whose tenant is null — an ingress boundary
 * with no scope — stays visible, since it carries no tenant
 * material. The trace id itself is an unguessable 128-bit
 * identifier; a trace from another tenant reads as 404 (no
 * existence leak).
 */
import { readJobHistory } from "./createShardJobPorts";
import { readTraceHops } from "./createMeshTracePorts";
import type { MeshTraceHop } from "./meshTracePorts";
import type { ShardJobRow } from "./shardJobPorts";
import {
  assembleMeshTrace,
  type MeshTraceAssembly,
} from "../observability/meshTrace";

/** A W3C trace id: exactly 32 lowercase hex characters. */
export const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export interface MeshTraceRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  traceId: string;
  /**
   * Assembled trace, or null when the store is unbound. A
   * throw reads as a 500 (read failure), mirroring the
   * jobs/history route's read-failure branch.
   */
  readTrace: (traceId: string) => Promise<MeshTraceAssembly | null>;
}

export async function handleMeshTraceRoute(
  input: MeshTraceRouteInput,
): Promise<Response> {
  if (!input.session) {
    return json({ error: "unauthorized" }, 401);
  }
  if (input.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (!input.traceId) {
    return json({ error: "traceId_required" }, 400);
  }
  if (!TRACE_ID_SHAPE.test(input.traceId)) {
    return json({ error: "traceId_invalid" }, 400);
  }
  let assembly: MeshTraceAssembly | null;
  try {
    assembly = await input.readTrace(input.traceId);
  } catch {
    return json({ error: "trace_read_failed" }, 500);
  }
  if (assembly === null) {
    return json(
      { error: "Trace history unavailable: AgentDB is not bound." },
      503,
    );
  }
  if (assembly.hops.length === 0) {
    return json({ error: "trace_not_found" }, 404);
  }
  return json(
    {
      traceId: assembly.traceId,
      complete: assembly.complete,
      hops: assembly.hops,
      breaks: assembly.breaks,
      jobIds: assembly.jobIds,
    },
    200,
  );
}

/** Test seams for the reader: production uses the store-backed reads. */
export interface TraceReaderDeps {
  readHops?: (traceId: string) => Promise<MeshTraceHop[]>;
  readJobs?: (tenantId: string, chainId: string) => Promise<ShardJobRow[] | null>;
}

/**
 * Build the route's trace reader for an env + tenant.
 * Null when AGENT_DB is unbound: the durable hop record
 * requires AGENT_DB, and isolate-local in-memory hops are
 * never served as a trace (they would be partial and
 * misleading — the hop's isolate is almost never the
 * reader's isolate). A failing job read degrades to no
 * rows for that job, never a throw.
 */
export function createTraceReader(
  env: { AGENT_DB?: unknown },
  tenantId: string,
  deps: TraceReaderDeps = {},
): (traceId: string) => Promise<MeshTraceAssembly | null> {
  const readHops =
    deps.readHops ?? ((id: string) => readTraceHops(env, id));
  const readJobs =
    deps.readJobs ?? ((t: string, c: string) => readJobHistory(env, t, c));
  return async (traceId: string) => {
    if (!env.AGENT_DB) return null;
    const allHops = await readHops(traceId);
    const hops = allHops.filter(
      (hop) =>
        hop.tenantId === undefined ||
        hop.tenantId === null ||
        hop.tenantId === tenantId,
    );
    const jobIds = [
      ...new Set(
        hops
          .map((hop) => hop.jobId)
          .filter((j): j is string => typeof j === "string" && j.length > 0),
      ),
    ];
    const rows: ShardJobRow[] = [];
    for (const jobId of jobIds) {
      const jobRows = await readJobs(tenantId, jobId).catch(() => null);
      if (jobRows) rows.push(...jobRows);
    }
    return assembleMeshTrace(traceId, hops, rows);
  };
}
