/**
 * Issue #1737 — route-side helpers for starting screener
 * workflows from the synchronous screen routes (Controller
 * pattern: the route builds the command, this module starts
 * it). Route-side only — never imported by the port, the
 * flows, or the adapters.
 *
 * Fallback rule: async start is best-effort. Any failure
 * (unbound workflow, unbound projection store, invalid
 * command, start error) returns null and the caller falls
 * back to the synchronous path — an opt-in async flag must
 * never 500 a screen the sync path can serve. Failures are
 * console.warned so operators see a degraded async path in
 * logs (a repeated-fallback alert is a follow-up).
 */
import type { Env } from "../types";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import {
  resolveScreenerNdGateFromEnv,
  screenerNdConfigErrorEvent,
} from "../config/screenerModes";
import { createWorkflowPorts } from "./createWorkflowPorts";
import {
  WorkflowError,
  type WorkflowHandle,
  type WorkflowJobCommand,
} from "./workflowPorts";

/** POST body `async: true` (the flag is stripped before schema validation by callers). */
export function asyncRequestedFromBody(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { async?: unknown }).async === true
  );
}

/** GET query `async=1`. */
export function asyncRequestedFromQuery(url: URL): boolean {
  return url.searchParams.get("async") === "1";
}

/**
 * Manual job id, mirroring the task-ledger key scheme
 * (screener:manual:<universe>:<timestamp>). Fresh per
 * start: a failed job is retried by starting a NEW command
 * with a NEW jobId, never by reusing one.
 */
export function manualWorkflowJobId(universe: string): string {
  return `screener:manual:${universe}:${new Date().toISOString()}`;
}

/** Tenant for projection rows: server-resolved, never caller input. */
export function workflowTenantId(env: Partial<Env> | null | undefined): string {
  return resolveIaaaTenant(env);
}

/**
 * Issue #2530 — the API seams' shared mode selection: raw
 * `screenMode` / `screenIntent` request fields (POST body or
 * GET query, already stripped from the filter payload by the
 * route, like `async`) → the fields a workflow command
 * carries, or a refusal the route answers 400 with. ND is
 * admissible only with the SCREENER_ND_MODE gate open and a
 * non-blank intent; an intent without ND mode refuses (it
 * would be silently ignored); an unknown mode refuses.
 * Routes additionally require the async path for ND — a
 * synchronous ND request is a 400, never a silent
 * synchronous deterministic screen.
 */
export type ScreenModeSelection =
  | { ok: true; screenMode?: "non-deterministic"; screenIntent?: string }
  | { ok: false; error: string };

/** The raw dual-mode fields of a screen request: POST body or GET query. */
export function screenModeFieldsFromRequest(
  method: string,
  body: { screenMode?: unknown; screenIntent?: unknown },
  query: URLSearchParams,
): { screenMode?: unknown; screenIntent?: unknown } {
  return method === "POST"
    ? { screenMode: body.screenMode, screenIntent: body.screenIntent }
    : {
        screenMode: query.get("screenMode") ?? undefined,
        screenIntent: query.get("screenIntent") ?? undefined,
      };
}

export function screenModeSelectionFromFields(
  env: unknown,
  fields: { screenMode?: unknown; screenIntent?: unknown },
  opts?: { asyncRequested?: boolean },
): ScreenModeSelection {
  const { screenMode, screenIntent } = fields;
  if (screenMode === undefined || screenMode === "deterministic") {
    if (screenIntent !== undefined) {
      return {
        ok: false,
        error:
          "screenIntent is only valid with screenMode \"non-deterministic\" — an intent on a deterministic screen would be silently ignored.",
      };
    }
    return { ok: true };
  }
  if (screenMode !== "non-deterministic") {
    return {
      ok: false,
      error: `screenMode must be "deterministic" or "non-deterministic" when present, got "${String(screenMode)}".`,
    };
  }
  const gate = resolveScreenerNdGateFromEnv(env);
  if (gate.invalid) {
    console.warn(
      `[screener-workflow] ${screenerNdConfigErrorEvent()}: SCREENER_ND_MODE value ${JSON.stringify(gate.raw)} is not "on"/"off" — failing closed to off.`,
    );
  }
  if (!gate.enabled) {
    return {
      ok: false,
      error:
        "The non-deterministic screener mode is disabled in this deployment (SCREENER_ND_MODE is off). The request was refused — it is never silently downgraded to a deterministic screen.",
    };
  }
  const intent = typeof screenIntent === "string" ? screenIntent.trim() : "";
  if (!intent) {
    return {
      ok: false,
      error:
        "screenMode \"non-deterministic\" requires a non-blank screenIntent (the free-form intent the run's interpretation step proposes criteria from).",
    };
  }
  if (opts?.asyncRequested === false) {
    return {
      ok: false,
      error:
        "screenMode \"non-deterministic\" requires the async workflow path (set async so the run starts as a workflow). A synchronous non-deterministic screen is never substituted with a synchronous deterministic one.",
    };
  }
  return { ok: true, screenMode: "non-deterministic", screenIntent: intent };
}

/** Start a workflow when the port is available; null → caller falls back to sync. */
export async function tryStartScreenerWorkflow(
  env: Env,
  command: WorkflowJobCommand,
): Promise<WorkflowHandle | null> {
  // Issue #2530 backstop, BEFORE the fallback try/catch: an
  // ND command while the gate is closed THROWS instead of
  // returning null — the null path means "fall back to the
  // synchronous screen", which for an ND request would be a
  // silent downgrade to a deterministic run the caller did
  // not ask for. Wired seams refuse earlier (400); this is
  // the guarantee for every other present or future caller.
  if (command.screenMode === "non-deterministic") {
    const gate = resolveScreenerNdGateFromEnv(env);
    if (gate.invalid) {
      console.warn(
        `[screener-workflow] ${screenerNdConfigErrorEvent()}: SCREENER_ND_MODE value ${JSON.stringify(gate.raw)} is not "on"/"off" — failing closed to off.`,
      );
    }
    if (!gate.enabled) {
      throw new WorkflowError(
        "invalid_command",
        "Non-deterministic screen command refused: the SCREENER_ND_MODE gate is closed in this environment (issue #2530). Refusing the start outright — never a synchronous deterministic fallback.",
      );
    }
  }
  try {
    const ports = createWorkflowPorts(env);
    if (!ports) return null;
    return await ports.start(command);
  } catch (err) {
    console.warn(
      "[screener-workflow] Async start failed, falling back to sync:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 202 response for an accepted async screen. */
export function workflowAcceptedResponse(handle: WorkflowHandle): Response {
  return Response.json(
    {
      jobId: handle.jobId,
      workflowId: handle.workflowId,
      status: "queued",
      ...(handle.existing ? { existing: true } : {}),
      statusUrl: handle.statusUrl,
    },
    { status: 202 },
  );
}
