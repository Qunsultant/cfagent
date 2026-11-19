/**
 * Issue #5175 slice 5 — the id-resolution shape, shared by the API
 * route (GET /api/ids/resolve) and the MCP resolve_id tool.
 *
 * Pure: it shapes a registry ResolveIdResult (slice 2's resolve port)
 * into the wire answer. It never mints, never reads a store — the
 * caller composes the resolve port (slice 2's createRunRegistryPorts)
 * over its host's storage and passes the result in. The API route and
 * the MCP command return byte-identical shapes because they share
 * this function.
 *
 * Shape decisions (recorded; the addendum's `{ level, kind,
 * canonicalId, runId, links }` was PROPOSED, not ruled):
 *  - `kind` is the resolution kind: "run" | "alias" | "derived" |
 *    "unknown". It is the primary discriminator.
 *  - `level` is always "run": the registry resolves TO a run record
 *    (mas_runs); the resolution target is a run, whatever the queried
 *    id's own type was.
 *  - `type` is the canonical type of the queried id (parseId's first
 *    segment — run / stage / step / event / trace / gen / delivery /
 *    or a job-instance kind); null for legacy aliases, which have no
 *    canonical type.
 *  - `canonicalId` and `runId` coincide in this slice (the registry
 *    only holds runs); both are carried per the addendum's shape, so
 *    a future transaction registry — where the canonical id of a
 *    transaction and its run would differ — needs no shape change.
 *  - `alias` is present only for kind "alias" (the queried legacy id).
 *  - `links` is NOT carried: no stable per-run URL exists (Workflow
 *    Runs has only a list route, no per-run deep link), and inventing
 *    one would be fabrication. The row fields (family / jobKind /
 *    trigger / createdAt) carry the provenance instead.
 *  - Wire fields are camelCase (jobKind, createdAt), following the
 *    MCP receipt / async-job idiom; the stored row stays snake_case.
 *  - "unknown" is a 200 answer, never a 404: the resolver's job is to
 *    answer "what is this id", and "unknown" is a legitimate answer.
 *    A non-canonical, unrecorded string cannot be distinguished from
 *    a malformed one without duplicating the slice-4 pin's
 *    legacy-family enumeration — the registry is the single
 *    authority, so the resolver does not invent a second verdict.
 *    "Malformed" exists only at the transport edge: a missing or
 *    empty `id` (API 400; MCP zod min(1)).
 */
import { parseId } from "./executionTreeIds";
import type { ResolveIdResult } from "../data/runRegistryPorts";

/** The wire answer for one resolved (or unresolvable) id. */
export type IdResolution =
  | {
      found: true;
      kind: "run" | "alias" | "derived";
      /** The queried id, echoed. */
      id: string;
      /** The canonical run id this id resolves to. */
      canonicalId: string;
      /** The run this id belongs to (== canonicalId in this slice). */
      runId: string;
      /** The resolution target's level — always "run". */
      level: "run";
      /** The queried id's canonical type, or null for legacy aliases. */
      type: string | null;
      /** The run row's family short id, or null when unknown. */
      family: string | null;
      /** The run row's job kind / spec, or null when unknown. */
      jobKind: string | null;
      /** What caused the run, or null when unknown. */
      trigger: string | null;
      /** The run row's creation instant (ISO). */
      createdAt: string;
      /** Present only for kind "alias": the queried legacy id. */
      alias?: string;
    }
  | {
      found: false;
      kind: "unknown";
      /** The queried id, echoed. */
      id: string;
    };

/** Shape one registry answer into the wire answer. Pure. */
export function toIdResolution(id: string, result: ResolveIdResult): IdResolution {
  if (!result.found) {
    return { found: false, kind: "unknown", id };
  }
  // The queried id's canonical type when it has one; legacy aliases
  // never parse, so their type is null (the adapter refuses canonical
  // ids as alias rows, so an alias can never carry a canonical type).
  let type: string | null = null;
  try {
    type = parseId(id).type;
  } catch {
    type = null;
  }
  const base = {
    found: true as const,
    id,
    canonicalId: result.runId,
    runId: result.runId,
    level: "run" as const,
    type,
    family: result.row.family,
    jobKind: result.row.job_kind,
    trigger: result.row.trigger,
    createdAt: result.row.created_at,
  };
  if (result.kind === "alias") {
    return { ...base, kind: "alias" as const, alias: result.alias };
  }
  if (result.kind === "derived") {
    return { ...base, kind: "derived" as const };
  }
  return { ...base, kind: "run" as const };
}
