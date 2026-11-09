/**
 * Issue #1738 — actor port factory (mirrors createMessagingPorts /
 * createWorkflowPorts).
 *
 * `runtime: "cf"` binds the port to a live Agents SDK actor (its
 * ctx.storage + scheduler + hooks); `runtime: "in-memory"` binds it
 * to Map/array-backed facets for tests. Both runtimes satisfy the
 * same conformance suite, which is the independence proof: swapping
 * the runtime never touches the actor's domain code.
 *
 * Issue #1935 (O3 spike) — `runtime: "think"` binds the port to a
 * Think agent behind the same facets. The turn facet is INJECTED
 * (deps.thinkTurn) rather than imported: thinkAdapter.ts imports
 * `@cloudflare/think`, whose runtime graph needs workerd schemes
 * the repo's node vitest harness cannot load, so importing it here
 * would break node test collection of this factory. The think
 * branch itself is Think-free (cf state/schedule/session +
 * injected turn); a Think agent class wires it via
 * createThinkActorPort in thinkAdapter.ts.
 */
import {
  createCfActorSchedule,
  createCfActorSession,
  createCfActorState,
  createCfActorTurn,
  createCfActorWorkspace,
  type SchedulerLike,
  type WorkspaceHostLike,
} from "./cfAgentsAdapter";
import {
  createInMemoryActorSchedule,
  createInMemoryActorSession,
  createInMemoryActorState,
  createInMemoryActorTurn,
  createInMemoryActorWorkspace,
} from "./inMemoryActorAdapter";
import type {
  ActorPort,
  ActorSessionPort,
  ActorTurnHooks,
  ActorTurnPort,
  ActorWorkspacePort,
} from "./actorPorts";

export type ActorRuntime = "cf" | "in-memory" | "think";

export interface CreateActorPortsDeps {
  hooks: ActorTurnHooks;
  /** Live actor's ctx.storage (cf, think) — unused for in-memory. */
  storage?: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    sql: { exec(sql: string, ...params: unknown[]): Iterable<unknown> };
  };
  /** Live actor's scheduler surface (cf, think) — unused for in-memory. */
  scheduler?: SchedulerLike;
  /** Optional host workspace bindings (think `_hostReadFile` etc.). */
  hostWorkspace?: WorkspaceHostLike;
  /** Optional pre-built workspace port override. */
  workspace?: ActorWorkspacePort;
  /**
   * Think turn facet, injected by the caller (think only). A
   * function of the session so the factory can build the session
   * first and hand it to the turn, with no import cycle.
   */
  thinkTurn?: (session: ActorSessionPort) => ActorTurnPort;
}

export function createActorPorts(runtime: ActorRuntime, deps: CreateActorPortsDeps): ActorPort {
  if (runtime === "in-memory") {
    const session = createInMemoryActorSession();
    return {
      state: createInMemoryActorState(),
      schedule: createInMemoryActorSchedule(),
      session,
      turn: createInMemoryActorTurn(deps.hooks, session),
      workspace: deps.workspace ?? createInMemoryActorWorkspace(),
    };
  }
  if (runtime === "think") {
    if (!deps.storage || !deps.scheduler || !deps.thinkTurn) {
      throw new Error("createActorPorts(think) requires storage, scheduler, and thinkTurn.");
    }
    const session = createCfActorSession(deps.storage);
    return {
      state: createCfActorState(deps.storage),
      schedule: createCfActorSchedule(deps.scheduler),
      session,
      turn: deps.thinkTurn(session),
      workspace: deps.workspace ?? createCfActorWorkspace(deps.storage, deps.hostWorkspace),
    };
  }
  if (!deps.storage || !deps.scheduler) {
    throw new Error("createActorPorts(cf) requires storage and scheduler.");
  }
  const session = createCfActorSession(deps.storage);
  return {
    state: createCfActorState(deps.storage),
    schedule: createCfActorSchedule(deps.scheduler),
    session,
    turn: createCfActorTurn(deps.hooks, session),
    workspace: deps.workspace ?? createCfActorWorkspace(deps.storage, deps.hostWorkspace),
  };
}
