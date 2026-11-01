/**
 * Shared-orchestrator address migration (issue #2681).
 *
 * Renaming SHARED_ORCHESTRATOR_INSTANCE orphans the live state behind
 * the old address (armed schedules, stored execution context), so the
 * rename ships with a migration: export from the source instance,
 * import into the target instance, verify counts, and only then flip
 * the constant. The driver runs on the target instance and pulls from
 * the source instance through its export ops; the operator passes the
 * source address explicitly (the legacy address, once, at run time).
 *
 * What migrates:
 * - SDK schedules, re-armed on the target (new SDK ids — ids never
 *   survive a copy) with fingerprint dedupe, so a re-run never
 *   double-arms.
 * - paused_schedules rows and every other user SQL table discovered
 *   via sqlite_master, as history, with one exclusion: in-flight
 *   mas_async_jobs rows (queued/running) are NOT copied — they drain
 *   on the source instance, whose alarms keep firing current code
 *   against its own storage.
 * - Every KV key (storage.list), which carries the stored execution
 *   context (screener:execution-context) and the legacy-baseline and
 *   last-slot keys.
 *
 * What does NOT migrate, by design: SDK internals (cf_agents_* queue
 * rows, cf_ai_* chat session). The source instance is never deleted
 * (no delete API exists); after the flip it simply receives no new
 * work.
 *
 * Gate: the same platform-admin, wired-session-only gate as the
 * service-user routes (resolveCaller), never a service-token caller.
 * The routes run in the DO onRequest chain and need the early
 * onRequest branch (like the service-user provision route) so POSTs
 * are not async-queued into 202s.
 */
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { resolveCaller, type ServiceUserRouteContext } from "./serviceUser";
import { canonicalJson } from "../../services/scheduleDedupe";
import { sessionStore } from "../../security/session";
import type { MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";

export interface MigrationSchedule {
  id: string;
  callback: string;
  payload: unknown;
  type: "scheduled" | "delayed" | "cron" | "interval";
  time: number;
  cron?: string;
  intervalSeconds?: number;
  delayInSeconds?: number;
}

export interface MigrationSql {
  exec(sql: string, ...args: unknown[]): Iterable<unknown>;
}

export interface MigrationStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { limit?: number; startAfter?: string }): Promise<Map<string, unknown>>;
  sql: MigrationSql;
}

export interface OrchestratorMigrationContext {
  env: Env;
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: membership store for the admin gate. */
  membershipStore?: MembershipStore;
  /** Test seam: alias KV for the admin gate. */
  aliasKv?: KvLike;
  storage: MigrationStorage;
  listSchedules(): Promise<MigrationSchedule[]>;
  schedule(
    when: Date | string,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean },
  ): Promise<unknown>;
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: unknown,
  ): Promise<unknown>;
  /** Test seam: address another instance. Defaults to the SEARCH_AGENT binding. */
  fetchInstance?(address: string): { fetch(req: Request): Promise<Response> };
}

const KV_PAGE_SIZE = 500;
/** SDK-internal tables: queue rows and chat session never migrate. */
const EXCLUDED_TABLE_PREFIXES = ["sqlite_", "cf_agents_", "cf_ai_"];

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stable identity for a schedule across export/import: callback +
 * payload + cadence key (cron string, interval seconds, or absolute
 * next-fire time for one-off schedules). SDK ids are never part of it
 * — they do not survive a copy.
 */
export function scheduleFingerprint(schedule: {
  callback: string;
  payload: unknown;
  type: string;
  cron?: unknown;
  intervalSeconds?: unknown;
  time?: unknown;
}): string {
  const key =
    schedule.type === "cron"
      ? schedule.cron
      : schedule.type === "interval"
        ? schedule.intervalSeconds
        : schedule.time;
  return canonicalJson({ callback: schedule.callback, payload: schedule.payload ?? null, key });
}

async function resolveAdmin(
  request: Request,
  ctx: OrchestratorMigrationContext,
): Promise<Response | null> {
  const caller = await resolveCaller(request, {
    env: ctx.env,
    audit: ctx.audit,
    membershipStore: ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env)),
    aliasKv: ctx.aliasKv ?? sessionStore(ctx.env),
  } as ServiceUserRouteContext);
  return caller instanceof Response ? caller : null;
}

interface ExportKvEntry {
  key: string;
  value: unknown;
}

async function exportKvPage(
  ctx: OrchestratorMigrationContext,
  cursor?: string,
): Promise<{ entries: ExportKvEntry[]; nextCursor: string | null }> {
  const page = await ctx.storage.list({ limit: KV_PAGE_SIZE, startAfter: cursor });
  const entries: ExportKvEntry[] = [];
  let lastKey: string | null = null;
  for (const [key, value] of page) {
    try {
      JSON.stringify(value);
    } catch {
      // Unserializable values are named as skipped by the driver
      // (it reports them); they are not silently dropped here —
      // the entry is still returned with a null marker.
      entries.push({ key, value: null });
      lastKey = key;
      continue;
    }
    entries.push({ key, value });
    lastKey = key;
  }
  return { entries, nextCursor: page.size === KV_PAGE_SIZE ? lastKey : null };
}

async function exportTables(
  ctx: OrchestratorMigrationContext,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const discovered = Array.from(
    ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'"),
  ) as Array<{ name: string }>;
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const { name } of discovered) {
    if (EXCLUDED_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = Array.from(ctx.storage.sql.exec(`SELECT * FROM ${name}`)) as Array<
        Record<string, unknown>
      >;
    } catch {
      // A table that cannot be read is reported, not silently skipped:
      // the driver surfaces tableErrors, and the operator re-runs.
      tables[name] = [];
      continue;
    }
    if (name === "mas_async_jobs") {
      // In-flight rows drain on the source instance; only finished
      // rows migrate, as history.
      rows = rows.filter((row) => row.status !== "queued" && row.status !== "running");
    }
    tables[name] = rows;
  }
  return tables;
}

async function exportSchedules(
  ctx: OrchestratorMigrationContext,
): Promise<MigrationSchedule[]> {
  return ctx.listSchedules();
}

interface ImportInput {
  kv?: ExportKvEntry[];
  tables?: Record<string, Array<Record<string, unknown>>>;
  schedules?: MigrationSchedule[];
}

interface ImportResult {
  kvImported: number;
  tables: Record<string, number>;
  tableErrors: Array<{ table: string; error: string }>;
  schedulesRearmed: number;
  schedulesSkipped: number;
  scheduleErrors: Array<{ id: string; error: string }>;
}

async function importData(
  ctx: OrchestratorMigrationContext,
  input: ImportInput,
): Promise<ImportResult> {
  const result: ImportResult = {
    kvImported: 0,
    tables: {},
    tableErrors: [],
    schedulesRearmed: 0,
    schedulesSkipped: 0,
    scheduleErrors: [],
  };
  for (const entry of input.kv ?? []) {
    if (entry.value === null) continue;
    await ctx.storage.put(entry.key, entry.value);
    result.kvImported += 1;
  }
  for (const [table, rows] of Object.entries(input.tables ?? {})) {
    let count = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const placeholders = cols.map(() => "?").join(", ");
      try {
        ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
          ...cols.map((c) => row[c]),
        );
        count += 1;
      } catch (error) {
        result.tableErrors.push({
          table,
          error: error instanceof Error ? error.message : "insert failed",
        });
        break;
      }
    }
    result.tables[table] = count;
  }
  if (input.schedules !== undefined) {
    const existing = await ctx.listSchedules();
    const fingerprints = new Set(existing.map((s) => scheduleFingerprint(s)));
    for (const schedule of input.schedules) {
      const fingerprint = scheduleFingerprint(schedule);
      if (fingerprints.has(fingerprint)) {
        result.schedulesSkipped += 1;
        continue;
      }
      try {
        if (schedule.type === "cron" && typeof schedule.cron === "string") {
          await ctx.schedule(schedule.cron, schedule.callback, schedule.payload, {
            idempotent: true,
          });
        } else if (schedule.type === "interval" && typeof schedule.intervalSeconds === "number") {
          await ctx.scheduleEvery(schedule.intervalSeconds, schedule.callback, schedule.payload);
        } else if (
          (schedule.type === "scheduled" || schedule.type === "delayed") &&
          typeof schedule.time === "number"
        ) {
          await ctx.schedule(new Date(schedule.time * 1000), schedule.callback, schedule.payload);
        } else {
          result.scheduleErrors.push({ id: schedule.id, error: "unknown schedule type" });
          continue;
        }
        fingerprints.add(fingerprint);
        result.schedulesRearmed += 1;
      } catch (error) {
        result.scheduleErrors.push({
          id: schedule.id,
          error: error instanceof Error ? error.message : "re-arm failed",
        });
      }
    }
  }
  return result;
}

async function handleExport(
  ctx: OrchestratorMigrationContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const section = body.section as string | undefined;
  if (section === "kv") {
    const page = await exportKvPage(
      ctx,
      typeof body.cursor === "string" ? body.cursor : undefined,
    );
    return Response.json({ ok: true, section, entries: page.entries, nextCursor: page.nextCursor });
  }
  if (section === "tables") {
    return Response.json({ ok: true, section, tables: await exportTables(ctx) });
  }
  if (section === "schedules") {
    return Response.json({ ok: true, section, schedules: await exportSchedules(ctx) });
  }
  return jsonError(`Unknown export section: ${String(section)}.`, 400);
}

async function handleMigrate(
  request: Request,
  ctx: OrchestratorMigrationContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const sourceAddress = typeof body.sourceAddress === "string" ? body.sourceAddress.trim() : "";
  if (!sourceAddress) {
    return jsonError("sourceAddress is required.", 400);
  }
  const fetchInstance =
    ctx.fetchInstance ??
    ((address: string) => {
      const ns = (ctx.env as unknown as { SEARCH_AGENT: { get(id: unknown): { fetch(r: Request): Promise<Response> }; idFromName(name: string): unknown } }).SEARCH_AGENT;
      return ns.get(ns.idFromName(address));
    });
  const callerLogin = request.headers.get("x-user-login") || "";
  const totals: ImportResult = {
    kvImported: 0,
    tables: {},
    tableErrors: [],
    schedulesRearmed: 0,
    schedulesSkipped: 0,
    scheduleErrors: [],
  };
  const tableCounts: Record<string, number> = {};
  const fetchSection = async (section: string, extra: Record<string, unknown> = {}) => {
    const res = await fetchInstance(sourceAddress).fetch(
      new Request("https://agent.internal/admin/orchestrator-migration/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-login": callerLogin,
        },
        body: JSON.stringify({ section, ...extra }),
      }),
    );
    if (!res.ok) {
      throw new Error(`source export ${section} failed with ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    // KV pages first: the driver loops until the source reports no cursor.
    let cursor: string | undefined;
    do {
      const page = await fetchSection("kv", cursor ? { cursor } : {});
      const imported = await importData(ctx, {
        kv: page.entries as ExportKvEntry[],
      });
      totals.kvImported += imported.kvImported;
      cursor =
        typeof page.nextCursor === "string" ? (page.nextCursor as string) : undefined;
    } while (cursor !== undefined);
    const tablesPage = await fetchSection("tables");
    const tablesImported = await importData(ctx, {
      tables: tablesPage.tables as Record<string, Array<Record<string, unknown>>>,
    });
    for (const [table, count] of Object.entries(tablesImported.tables)) {
      tableCounts[table] = count;
    }
    totals.tableErrors.push(...tablesImported.tableErrors);
    const schedulesPage = await fetchSection("schedules");
    const schedulesImported = await importData(ctx, {
      schedules: schedulesPage.schedules as MigrationSchedule[],
    });
    totals.schedulesRearmed += schedulesImported.schedulesRearmed;
    totals.schedulesSkipped += schedulesImported.schedulesSkipped;
    totals.scheduleErrors.push(...schedulesImported.scheduleErrors);
  } catch (error) {
    return jsonError(
      `Migration from ${sourceAddress} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  }
  const receipt = {
    sourceAddress,
    kvKeys: totals.kvImported,
    tables: tableCounts,
    schedulesRearmed: totals.schedulesRearmed,
    schedulesSkipped: totals.schedulesSkipped,
    tableErrors: totals.tableErrors,
    scheduleErrors: totals.scheduleErrors,
    completedAtMs: Date.now(),
  };
  await ctx.storage.put(`orchestrator-migration:receipt:${sourceAddress}`, receipt);
  ctx.audit("orchestrator_migration.completed", "orchestrator", {
    sourceAddress,
    kvKeys: receipt.kvKeys,
    tables: receipt.tables,
    schedulesRearmed: receipt.schedulesRearmed,
    schedulesSkipped: receipt.schedulesSkipped,
  });
  return Response.json({ ok: true, ...receipt });
}

export async function handleOrchestratorMigrationRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: OrchestratorMigrationContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  let action: "export" | "import" | "migrate" | null = null;
  if (path.endsWith("/admin/orchestrator-migration/export")) {
    action = "export";
  } else if (path.endsWith("/admin/orchestrator-migration/import")) {
    action = "import";
  } else if (path.endsWith("/admin/orchestrator-migration/migrate")) {
    action = "migrate";
  } else {
    return null;
  }
  if (request.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }
  try {
    const denial = await resolveAdmin(request, ctx);
    if (denial) return denial;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (action === "export") return handleExport(ctx, body);
    if (action === "import") {
      const result = await importData(ctx, {
        kv: Array.isArray(body.kv) ? (body.kv as ExportKvEntry[]) : undefined,
        tables: isRecord(body.tables)
          ? (body.tables as Record<string, Array<Record<string, unknown>>>)
          : undefined,
        schedules: Array.isArray(body.schedules)
          ? (body.schedules as MigrationSchedule[])
          : undefined,
      });
      return Response.json({ ok: true, ...result });
    }
    return handleMigrate(request, ctx, body);
  } catch {
    return jsonError("Orchestrator migration unavailable.", 500);
  }
}
