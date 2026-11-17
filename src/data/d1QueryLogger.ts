/**
 * Issue #4933 — Drizzle query observability: one shared wiring point for
 * the drizzle() construction path. No per-adapter loggers: every D1
 * adapter builds its db through `createDrizzleD1Db`, which times the
 * D1 binding's prepared-statement execution and emits statement +
 * duration through the structured-logging seam.
 *
 * WHY A BINDING WRAPPER, NOT THE drizzle `logger` OPTION. drizzle-orm
 * 0.45.4's Logger interface is `logQuery(query, params): void`, invoked
 * synchronously BEFORE execution, with no completion hook — it cannot
 * measure duration, and the issue requires statement + duration. A
 * logger option would also double-log if combined with a timer. So the
 * shared constructor leaves drizzle's logger at its default (NoopLogger)
 * and instead wraps the D1 binding: prepare() returns a statement proxy
 * that times run/all/first/raw, batch() unwraps statements before the
 * real batch (native D1 batch() requires genuine D1PreparedStatements;
 * a Proxy would fail its brand check), exec() is timed. Exactly one
 * `d1_query` event is emitted per execution, carrying both the statement
 * and its duration.
 *
 * DESTINATION. The events ride the S2 structured-logging seam (the
 * #4930 d1RetryPolicy telemetry idiom): Analytics Engine dataset
 * `observability` in production, the JSON console fallback otherwise.
 * No new sink, table, or dashboard.
 *
 * REDACTION. Param VALUES are never logged — only paramCount and
 * per-param type names. The statement text is literal-masked
 * (quoted string literals become `?`): drizzle parameterizes values,
 * so SQL text carries `?` placeholders; the masking defends against
 * `sql.raw()` inlining. Tests prove both.
 *
 * THE LOGGER NEVER FAILS THE CALLER. A throwing sink is swallowed by
 * the structured logger (its own contract). A failing query emits an
 * error-level event and rethrows the ORIGINAL error.
 *
 * BOUNDARY. The transaction aspect's direct-binding batch
 * (`transactionAspect.ts`, D1BatchDatabase on the raw binding, not
 * through drizzle) is NOT observed here — a different path with no
 * drizzle construction site. Its per-unit telemetry already exists via
 * #4930 (`d1_retry.*` per unit, not per statement).
 */
import {
  drizzle,
  type AnyD1Database,
  type DrizzleD1Database,
} from "drizzle-orm/d1";
import type { DrizzleConfig } from "drizzle-orm";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { ObservabilitySink } from "../observability/observabilityPorts";
import { parseIntClamped } from "./d1RetryPolicy";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "data/d1QueryLogger",
});

/** The slow-query budget shape: one number, the warn threshold. */
export interface D1QueryLoggerPolicy {
  /** Duration at or above which a query is slow (warn level). */
  slowQueryThresholdMs: number;
}

/** The recorded budget: 100ms. D1 queries are normally single-digit ms. */
export const DEFAULT_D1_QUERY_LOGGER_POLICY: D1QueryLoggerPolicy = {
  slowQueryThresholdMs: 100,
};

/** Clamp bounds — the D1RetryPolicy bounds, reused, not re-invented. */
const SLOW_MIN_MS = 0;
const SLOW_MAX_MS = 120_000;

/**
 * Resolve the effective policy from operator settings and env, with the
 * defaults as the base. Precedence per key: settings, then env, then
 * default. Out-of-range values clamp instead of throwing; a non-numeric
 * value falls back to the default. The #4930 resolveD1RetryPolicy
 * pattern, one key instead of four.
 */
export function resolveD1QueryLoggerPolicy(
  env?: Record<string, unknown>,
  settings?: Record<string, string | undefined>,
): D1QueryLoggerPolicy {
  const raw = settings?.["d1.query.slowMs"] ?? readEnvMs(env);
  return {
    slowQueryThresholdMs:
      parseIntClamped(raw, SLOW_MIN_MS, SLOW_MAX_MS) ??
      DEFAULT_D1_QUERY_LOGGER_POLICY.slowQueryThresholdMs,
  };
}

function readEnvMs(env?: Record<string, unknown>): string | undefined {
  const value = env?.["D1_QUERY_SLOW_MS"];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Mask quoted string literals in a statement (`'...'` with `''`
 * escapes) with `?` and collapse whitespace. Param placeholders are
 * already `?`; numbers and identifiers pass through untouched.
 */
export function redactD1Statement(statement: string): string {
  let out = "";
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i];
    if (ch === "'") {
      i += 1;
      while (i < statement.length) {
        if (statement[i] === "'") {
          if (statement[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += "?";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The type name of one bound param — the value itself is never logged. */
function paramTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

type QueryKind = "run" | "all" | "first" | "raw" | "batch" | "exec";

interface QueryEmit {
  kind: QueryKind;
  statement: string;
  params: unknown[];
  statementCount?: number;
  statements?: string[];
  durationMs: number;
  error?: string;
}

/** Options for one logger instance. All optional; the module default applies. */
export interface D1QueryLoggerOptions {
  /** Sink override — tests pass a capturing sink. */
  sink?: ObservabilitySink;
  /** Policy override — the recorded default applies when omitted. */
  policy?: D1QueryLoggerPolicy;
  /** Clock override — the repo's injectable-clock idiom; Date.now by default. */
  nowMs?: () => number;
}

/** A query logger: the one object that can wrap a D1 binding. */
export interface D1QueryLogger {
  wrapD1<TClient extends AnyD1Database>(d1: TClient): TClient;
}

/**
 * Build a query logger. The emit closure is shared by every db the
 * logger wraps, so all D1 queries from one construction site report
 * through the same sink, policy, and clock.
 */
export function createD1QueryLogger(
  options: D1QueryLoggerOptions = {},
): D1QueryLogger {
  const log = options.sink
    ? createStructuredLogger(options.sink, { component: "data/d1QueryLogger" })
    : structuredLog;
  const policy = options.policy ?? DEFAULT_D1_QUERY_LOGGER_POLICY;
  const nowMs = options.nowMs ?? Date.now;

  function emit(emit: QueryEmit): void {
    const slow = emit.durationMs >= policy.slowQueryThresholdMs;
    const fields: Record<string, unknown> = {
      statement: redactD1Statement(emit.statement),
      paramCount: emit.params.length,
      paramTypes: emit.params.map(paramTypeName),
      durationMs: emit.durationMs,
      slow,
      kind: emit.kind,
      message: `[d1Query] ${emit.kind} ${emit.durationMs}ms${slow ? " SLOW" : ""}`,
    };
    if (emit.statementCount !== undefined) fields.statementCount = emit.statementCount;
    if (emit.statements !== undefined) {
      fields.statements = emit.statements.map(redactD1Statement);
    }
    if (emit.error !== undefined) {
      log.error("d1_query", { ...fields, error: emit.error.slice(0, 200) });
      return;
    }
    if (slow) {
      log.warn("d1_query", fields);
      return;
    }
    log.info("d1_query", fields);
  }

  return {
    wrapD1<TClient extends AnyD1Database>(d1: TClient): TClient {
      return wrapD1Database(d1 as unknown as D1Database, emit, nowMs) as unknown as TClient;
    },
  };
}

/** The module-default logger: the seam default, no injection. */
const defaultQueryLogger = createD1QueryLogger();

/** Per-statement metadata, keyed by the proxy that carries it. */
interface StatementMeta {
  sql: string;
  params: unknown[];
}

const statementMeta = new WeakMap<object, StatementMeta>();
/** Proxy -> the real statement underneath, for batch() unwrapping. */
const unwrappedStatements = new WeakMap<object, D1PreparedStatement>();

/** The root-cause message of a failure: unwrap `.cause` (drizzle wraps
 * the underlying error in a DrizzleQueryError whose message is only
 * "Failed query: ..."). The event records the cause the operator needs;
 * the caller still receives the original error object untouched. */
function errorMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      current instanceof Error &&
      current.cause instanceof Error &&
      current.cause.message !== current.message
    ) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current instanceof Error ? current.message : String(current);
}

/** Time one prepared-statement execution and emit its event. */
async function timedExecution<T>(
  kind: QueryKind,
  meta: StatementMeta,
  emit: (emit: QueryEmit) => void,
  nowMs: () => number,
  run: () => Promise<T>,
): Promise<T> {
  const start = nowMs();
  try {
    const result = await run();
    emit({ kind, statement: meta.sql, params: meta.params, durationMs: nowMs() - start });
    return result;
  } catch (err) {
    emit({
      kind,
      statement: meta.sql,
      params: meta.params,
      durationMs: nowMs() - start,
      error: errorMessage(err),
    });
    throw err;
  }
}

function wrapStatement(
  stmt: D1PreparedStatement,
  sql: string,
  emit: (emit: QueryEmit) => void,
  nowMs: () => number,
  params: unknown[] = [],
): D1PreparedStatement {
  const meta: StatementMeta = { sql, params };
  const proxy = new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") {
        return (...bound: unknown[]) =>
          wrapStatement(target.bind(...bound), sql, emit, nowMs, bound);
      }
      if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
        const kind = prop as "run" | "all" | "first" | "raw";
        return (...args: unknown[]) =>
          timedExecution(
            kind,
            meta,
            emit,
            nowMs,
            () => (target[kind] as (...a: unknown[]) => Promise<unknown>)(...args),
          );
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;
  statementMeta.set(proxy, meta);
  unwrappedStatements.set(proxy, stmt);
  return proxy;
}

function wrapD1Database(
  d1: D1Database,
  emit: (emit: QueryEmit) => void,
  nowMs: () => number,
): D1Database {
  // An unbound/missing binding is not a query to observe: drizzle()
  // itself constructs fine around it and the refusal surfaces
  // downstream by name (e.g. feed_parity_3941's "dataset store
  // unbound" case, where env.AGENT_DB is undefined). A Proxy requires
  // an object target, so pass the binding through untouched — that
  // keeps construction-time behavior byte-identical to a bare
  // drizzle() call, and any use-time failure behaves exactly as
  // before. The logger simply observes nothing with no binding.
  if (d1 === null || (typeof d1 !== "object" && typeof d1 !== "function")) {
    return d1;
  }
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) =>
          wrapStatement(target.prepare(sql), sql, emit, nowMs);
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const start = nowMs();
          // Unwrap first: native D1 batch() requires genuine
          // D1PreparedStatements. A statement built outside this
          // wrapper passes through unchanged.
          const real = statements.map((s) => unwrappedStatements.get(s) ?? s);
          const metas = statements.map(
            (s) => statementMeta.get(s) ?? { sql: "(unknown)", params: [] as unknown[] },
          );
          try {
            const results = await target.batch(real);
            emit({
              kind: "batch",
              statement: metas.map((m) => m.sql).join("; "),
              params: metas.flatMap((m) => m.params),
              statementCount: statements.length,
              statements: metas.map((m) => m.sql),
              durationMs: nowMs() - start,
            });
            return results;
          } catch (err) {
            const message = errorMessage(err);
            emit({
              kind: "batch",
              statement: metas.map((m) => m.sql).join("; "),
              params: metas.flatMap((m) => m.params),
              statementCount: statements.length,
              statements: metas.map((m) => m.sql),
              durationMs: nowMs() - start,
              error: message,
            });
            throw err;
          }
        };
      }
      if (prop === "exec") {
        return async (query: string) => {
          const start = nowMs();
          try {
            const result = await target.exec(query);
            emit({ kind: "exec", statement: query, params: [], durationMs: nowMs() - start });
            return result;
          } catch (err) {
            const message = errorMessage(err);
            emit({
              kind: "exec",
              statement: query,
              params: [],
              durationMs: nowMs() - start,
              error: message,
            });
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Options for the shared constructor: a logger override only. */
export interface CreateDrizzleD1DbOptions {
  /**
   * Logger instance; the module default applies when omitted. A caller
   * WITH env/settings resolves a policy and builds a logger; the
   * call sites pass nothing and get the recorded default.
   */
  logger?: D1QueryLogger;
}

/**
 * THE shared drizzle() construction point. Every D1 adapter builds its
 * db through here — never a bare drizzle() call, never a per-adapter
 * logger. Mirrors drizzle()'s signature, minus the `logger` key: the
 * binding wrapper IS the logger, so a second one cannot be smuggled
 * in. The returned db is the same shape drizzle returns, with $client
 * set to the wrapped binding.
 */
export function createDrizzleD1Db<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends AnyD1Database = AnyD1Database,
>(
  client: TClient,
  config?: Omit<DrizzleConfig<TSchema>, "logger">,
  options?: CreateDrizzleD1DbOptions,
): DrizzleD1Database<TSchema> & { $client: TClient } {
  const logger = options?.logger ?? defaultQueryLogger;
  const wrapped = logger.wrapD1(client);
  return drizzle(wrapped, config);
}
