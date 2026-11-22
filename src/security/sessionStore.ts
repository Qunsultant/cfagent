import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  DoSessionStoreAdapter,
  STMT_ARCHIVE_INSERT,
  STMT_ARCHIVE_LIST,
  STMT_AUDIT_TABLE_COUNT,
  STMT_AUDIT_TABLE_INSERT,
  STMT_AUDIT_TABLE_LIST,
  STMT_AUDIT_TABLE_TAIL,
  STMT_DELETE,
  STMT_EXPIRES_GET,
  STMT_LIST,
  STMT_POINT_GET,
  STMT_UPSERT,
} from "../data/doSessionStoreAdapter";
import {
  computeEventHash,
  type CreateIaaaAuditEventInput,
  type IaaaAuditEvent,
} from "./iaaaAudit";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "./iaaaAuditStore";
import {
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_TABLE_KEY_PREFIX,
} from "../data/auditLogPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import {
  SESSION_STORE_CONFIG,
  SESSION_STORE_CONFIG_ERRORS,
} from "../config/sessionStoreConfig";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { ConsoleObservabilitySink } from "../observability/observabilityPorts";

/**
 * Session and credential store (issue #329 follow-up).
 *
 * Workers KV's free tier caps reads at 100k/day and, once exhausted, every
 * `get()` throws — which took authentication, and therefore the whole site,
 * down with Cloudflare error 1101. Sessions and E*TRADE tokens now live in
 * this Durable Object's SQLite store instead. CORRECTION (issue #1819):
 * DO SQLite on the free tier is NOT uncapped — it carries its own daily
 * limits (5M rows read/day, 100k rows written/day at the time of writing),
 * and exhausting the rows-read cap on 2026-10-26 took sign-in down the same
 * way KV exhaustion once did. The earlier "no daily read cap" wording was
 * wrong and is the direct cause of the surprise; see
 * docs/architecture/security/sessionstore-resource-measurement-1819.md.
 *
 * One instance (`idFromName("kv")`) holds every bucket, namespaced by `ns`, so
 * the client only has to add a binding — not a second index or routing scheme.
 *
 * Measurement (#1819): every op reply carries the platform-measured
 * rowsRead/rowsWritten summed across its statements (cursor totals, which the
 * old code discarded) plus the parameterized statement template. No bound
 * value ever appears in the statement field.
 */
interface StoreOp {
  op: "get" | "put" | "delete" | "consume" | "list" | "audit-append" | "audit-list" | "audit-migrate";
  ns: string;
  key: string;
  value?: string;
  ttl?: number;
  /** #1760 audit-append caps requested by the client (clamped server-side, see below). */
  liveMax?: number;
  segmentSize?: number;
  maxArchiveSegments?: number;
  /**
   * #3251 (O1) — "table" selects the append-only table
   * substrate for audit-append; absent (or any other value)
   * keeps the segment substrate. Only the flag-ON composition
   * sends it.
   */
  substrate?: string;
}

/**
 * #1760 — ceilings for the audit bound, externalized in
 * config/sessionstore.json (#6191). A client may request SMALLER
 * caps (tests, tighter deployments) but never larger ones: the
 * bound is enforcement, not a caller preference, so a caller
 * widening it would be disabling its own limit. Out-of-range or
 * missing values fall back to the ceiling. An invalid config
 * value fails closed to the documented default with a named
 * error (see the config resolver); the named errors are logged
 * once on first use, in store() below.
 */
const AUDIT_LIVE_MAX = SESSION_STORE_CONFIG.audit.liveMax;
const AUDIT_SEGMENT = SESSION_STORE_CONFIG.audit.segmentSize;
const AUDIT_SEGMENTS = SESSION_STORE_CONFIG.audit.maxSegments;

/** #6191 — the config errors are logged once, on first adapter use. */
let sessionStoreConfigErrorsLogged = false;

function clampAuditCap(requested: unknown, hard: number): number {
  return typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested > 0
    ? Math.min(requested, hard)
    : hard;
}

/** Minimal re-check of a client-validated audit input (defense in depth). */
function isAuditAppendInput(value: unknown): value is CreateIaaaAuditEventInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const str = (k: string): boolean =>
    typeof v[k] === "string" && (v[k] as string).trim().length > 0;
  return (
    str("type") &&
    str("actorPrincipalId") &&
    ["human", "service", "agent"].includes(String(v.actorType)) &&
    str("initiatingPrincipalId") &&
    str("tenantId") &&
    str("correlationId") &&
    str("action") &&
    ["allow", "deny"].includes(String(v.decision)) &&
    str("policyVersion") &&
    ["succeeded", "failed", "pending", "unknown"].includes(String(v.outcome)) &&
    typeof v.timestamp === "number" &&
    Number.isFinite(v.timestamp)
  );
}

function auditEventFromInput(
  input: CreateIaaaAuditEventInput,
): Omit<IaaaAuditEvent, "id" | "previousEventHash" | "eventHash"> {
  // Whitelist: only canonical fields reach the stored event.
  return {
    timestamp: input.timestamp,
    type: input.type,
    actorPrincipalId: input.actorPrincipalId,
    actorType: input.actorType,
    initiatingPrincipalId: input.initiatingPrincipalId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    agentInstanceId: input.agentInstanceId,
    agentRunId: input.agentRunId,
    delegationId: input.delegationId,
    correlationId: input.correlationId,
    action: input.action,
    resourceId: input.resourceId,
    decision: input.decision,
    policyVersion: input.policyVersion,
    approvalId: input.approvalId,
    outcome: input.outcome,
    errorCode: input.errorCode,
  };
}

/**
 * The kv_store schema generation this code creates and serves
 * (ADR 0022 D-A.4), externalized in config/sessionstore.json
 * (#6191 — the value is the documented default 1; the discipline
 * is unchanged). Generation 1 is the original shape — the
 * `kv_store` table below — recorded in the D-A.4 marker by the
 * constructor (#2432). Bump this only alongside a schema change
 * to kv_store itself, under runDoSchemaMigration discipline:
 * the marker row is the commit record for the change.
 */
export const SESSION_STORE_SCHEMA_VERSION =
  SESSION_STORE_CONFIG.schemaVersion;

export class SessionStore extends DurableObject<Env> {
  /**
   * Issue #2436 (#1976 step 5e): every kv_store statement
   * this class executes — the constructor DDL, the D-A.4
   * schema-marker recording and the seven op templates — is
   * owned by the data-layer adapter
   * (src/data/doSessionStoreAdapter.ts), built here over
   * this DO's own SqlStorage handle. The class keeps the
   * wire protocol and every policy decision (the list
   * restriction, the audit-append chaining/rotation/caps,
   * the expired-read delete); the adapter executes.
   */
  private kv?: DoSessionStoreAdapter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store().ensureSchema();
  }

  /**
   * The adapter is built LAZILY, on first use: before this
   * extraction the class kept no constructor-initialised
   * state at all — every op resolved this.ctx at call time —
   * and suites exercise the fetch logic on instances whose
   * constructor never ran (Object.create over the prototype,
   * #1819). The resolver inside the adapter likewise reads
   * the CURRENT ctx per statement.
   *
   * #6191 — the first build also logs any sessionstore config
   * errors once (the config is static, so once per process is
   * enough): an invalid value failed closed to the documented
   * default at import time, and the named error is surfaced
   * here rather than silently. Test instances built via
   * Object.create (no constructor, no env) fall back to the
   * structured console sink, as the fetch error path does.
   */
  private store(): DoSessionStoreAdapter {
    if (!this.kv) {
      if (!sessionStoreConfigErrorsLogged) {
        sessionStoreConfigErrorsLogged = true;
        for (const error of SESSION_STORE_CONFIG_ERRORS) {
          const structuredLog = createStructuredLogger(
            this.env
              ? createObservabilitySink(this.env)
              : new ConsoleObservabilitySink(),
            { component: "security/sessionStore" },
          );
          structuredLog.warn("sessionStore.config_invalid", {
            message: `[SessionStore] sessionstore config invalid: ${error}`,
            code: "sessionstore.config.invalid",
          });
        }
      }
      this.kv = new DoSessionStoreAdapter(
        () => this.ctx.storage.sql,
        SESSION_STORE_SCHEMA_VERSION,
      );
    }
    return this.kv;
  }

  /**
   * #3251 (O1) — explode the segment rows into the append-only
   * table, chain order preserved (archive segments in key
   * order, then the live key), one row per event with the event
   * JSON byte-identical to the segment bytes. Parse-first, then
   * insert: a corrupt live or archive value throws before any
   * row is written, and the segment bytes are left untouched
   * (callers convert the throw into the 500 "audit log corrupt"
   * reply the segments branch returns). Idempotent: a populated
   * table migrates nothing (`alreadyMigrated`). Old segment rows
   * are NOT deleted here — their removal is a separate named
   * step, never part of the migration.
   */
  private migrateSegmentsToTable(): {
    migrated: number;
    alreadyMigrated: boolean;
    rowsRead: number;
    rowsWritten: number;
  } {
    let rowsRead = 0;
    let rowsWritten = 0;
    const countMeasured = this.store().exec<{ n: number }>(STMT_AUDIT_TABLE_COUNT);
    rowsRead += countMeasured.rowsRead;
    rowsWritten += countMeasured.rowsWritten;
    if ((countMeasured.rows[0]?.n ?? 0) > 0) {
      return { migrated: 0, alreadyMigrated: true, rowsRead, rowsWritten };
    }
    const liveMeasured = this.store().exec<{ value: string }>(STMT_POINT_GET, "sessions", IAAA_AUDIT_LOG_KEY);
    rowsRead += liveMeasured.rowsRead;
    rowsWritten += liveMeasured.rowsWritten;
    const liveRow = liveMeasured.rows[0];
    let live: IaaaAuditEvent[];
    if (!liveRow) {
      live = [];
    } else {
      try {
        const parsed: unknown = JSON.parse(liveRow.value);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        live = parsed as IaaaAuditEvent[];
      } catch {
        throw new Error("audit log corrupt");
      }
    }
    const archiveMeasured = this.store().exec<{ key: string; value: string }>(
      STMT_ARCHIVE_LIST,
      "sessions",
      `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}%`,
    );
    rowsRead += archiveMeasured.rowsRead;
    rowsWritten += archiveMeasured.rowsWritten;
    const segments: IaaaAuditEvent[][] = [];
    for (const row of archiveMeasured.rows) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        segments.push(parsed as IaaaAuditEvent[]);
      } catch {
        throw new Error("audit log corrupt");
      }
    }
    const events = [...segments.flat(), ...live];
    let seq = 0;
    for (const event of events) {
      seq += 1;
      const inserted = this.store().exec(STMT_AUDIT_TABLE_INSERT, seq, JSON.stringify(event));
      rowsRead += inserted.rowsRead;
      rowsWritten += inserted.rowsWritten;
    }
    return { migrated: events.length, alreadyMigrated: false, rowsRead, rowsWritten };
  }

  async fetch(request: Request): Promise<Response> {
    let body: StoreOp;
    try {
      body = (await request.json()) as StoreOp;
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }

    const { op, ns, key } = body;
    // Issue #2489: a list with an empty key lists the whole namespace
    // (LIKE '%' — the offboarding path already passes "" for exactly
    // this, and the selective wipe's sessions row needs it). Every
    // other op still requires a key, and the namespace restriction
    // below still applies, so this widens nothing about who may list.
    if (!op || !ns || (op !== "list" && !key)) {
      return Response.json({ error: "op, ns and key are required" }, { status: 400 });
    }

    try {
      if (op === "list") {
        // #1758: the sessions namespace joins the E*TRADE token
        // namespace as listable. Listing sessions is what makes
        // bulk revocation possible: without it, an offboarding can
        // only revoke the session ids its caller already knows
        // (scan F-16). The DO itself performs no authorization —
        // it is reachable only through the Worker's internal stub
        // fetch, never from a client — so every list caller is a
        // server code path whose route gates the read (the IAAA
        // lifecycle routes are admin- or self-gated; the values
        // returned are full session records, so no new list caller
        // may be added without a route-level gate review).
        const listKey = key ?? "";
        const sessionsListAllowed = ns === "sessions";
        const etradeListAllowed = ns === "etrade" && listKey.startsWith("etrade:token:");
        if (!sessionsListAllowed && !etradeListAllowed) {
          return Response.json({ error: "list is restricted to session entries and E*TRADE token entries" }, { status: 400 });
        }
        const measured = this.store().exec<{ key: string; value: string }>(
          STMT_LIST,
          ns,
          `${listKey.replace(/[\\%_]/g, "\\$&")}%`,
          Date.now()
        );
        return Response.json({
          entries: measured.rows,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_LIST,
        });
      }

      if (op === "get") {
        const measured = this.store().exec<{ value: string; expires_at: number | null }>(
          STMT_POINT_GET,
          ns,
          key
        );
        const row = measured.rows[0];

        if (!row) {
          return Response.json({
            value: null,
            rowsRead: measured.rowsRead,
            rowsWritten: measured.rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
        if (row.expires_at !== null && row.expires_at <= Date.now()) {
          const deleted = this.store().exec(STMT_DELETE, ns, key);
          return Response.json({
            value: null,
            rowsRead: measured.rowsRead + deleted.rowsRead,
            rowsWritten: measured.rowsWritten + deleted.rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
        return Response.json({
          value: row.value,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_POINT_GET,
        });
      }

      if (op === "consume") {
        // Replay guard (issue #329 P3). A DO handles one request at a time, so
        // this read-then-write cannot interleave — unlike the KV get-then-put it
        // replaces, where two colos could both see "not consumed".
        const existing = this.store().exec<{ expires_at: number | null }>(
          STMT_EXPIRES_GET,
          ns,
          key
        );
        const row = existing.rows[0];

        if (row && (row.expires_at === null || row.expires_at > Date.now())) {
          return Response.json({
            consumed: false,
            rowsRead: existing.rowsRead,
            rowsWritten: existing.rowsWritten,
            statement: STMT_EXPIRES_GET,
          });
        }

        const claimedUntil =
          typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        const claimed = this.store().exec(STMT_UPSERT, ns, key, body.value ?? "", claimedUntil);
        return Response.json({
          consumed: true,
          rowsRead: existing.rowsRead + claimed.rowsRead,
          rowsWritten: existing.rowsWritten + claimed.rowsWritten,
          statement: STMT_EXPIRES_GET,
        });
      }

      if (op === "audit-append") {
        // #1760 — transactional audit append. This whole branch runs
        // inside ONE Durable Object request, and a DO handles one
        // request at a time, so the tail read, the chaining, the
        // rotation, and the write cannot interleave with a second
        // appender — the read-modify-write race in the old Kv audit
        // store (F-18) is closed here, not merely detected. The op
        // is restricted to the sessions bucket's audit log key;
        // arbitrary keys cannot be appended through it.
        if (ns !== "sessions" || key !== IAAA_AUDIT_LOG_KEY) {
          return Response.json(
            { error: "audit-append is restricted to the sessions audit log key" },
            { status: 400 },
          );
        }
        if (typeof body.value !== "string") {
          return Response.json({ error: "value is required for audit-append" }, { status: 400 });
        }
        let input: unknown;
        try {
          input = JSON.parse(body.value);
        } catch {
          return Response.json({ error: "invalid audit event" }, { status: 400 });
        }
        if (!isAuditAppendInput(input)) {
          return Response.json({ error: "invalid audit event" }, { status: 400 });
        }
        const liveMax = clampAuditCap(body.liveMax, AUDIT_LIVE_MAX);
        const segmentSize = clampAuditCap(body.segmentSize, AUDIT_SEGMENT);
        const maxSegments = clampAuditCap(body.maxArchiveSegments, AUDIT_SEGMENTS);
        const totalCap = liveMax + maxSegments * segmentSize;

        // #3251 (O1) — the append-only table substrate, behind
        // the flag (the client sends substrate "table" only on
        // the flag-ON composition). Same op, same input gate,
        // same caps and chain — only the row shape differs: the
        // tail is one indexed row, the cap is a COUNT(*), the
        // write is one row insert. The segments branch below is
        // untouched (flag-OFF keeps it). The first table append
        // migrates the segment bytes inline, in this same
        // serialized request, so the flag can flip before or
        // after an explicit migration without forking the chain.
        if (body.substrate === "table") {
          let rowsRead = 0;
          let rowsWritten = 0;
          let migration: {
            migrated: number;
            alreadyMigrated: boolean;
            rowsRead: number;
            rowsWritten: number;
          };
          try {
            migration = this.migrateSegmentsToTable();
          } catch {
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
          rowsRead += migration.rowsRead;
          rowsWritten += migration.rowsWritten;
          const tailMeasured = this.store().exec<{ seq: number; event_json: string }>(
            STMT_AUDIT_TABLE_TAIL,
          );
          rowsRead += tailMeasured.rowsRead;
          rowsWritten += tailMeasured.rowsWritten;
          const tailRow = tailMeasured.rows[0];
          let tailHash: string | null = null;
          let nextSeq = 1;
          if (tailRow) {
            try {
              const tailEvent: unknown = JSON.parse(tailRow.event_json);
              if (
                typeof tailEvent !== "object" ||
                tailEvent === null ||
                typeof (tailEvent as { eventHash?: unknown }).eventHash !== "string"
              ) {
                throw new Error("not an event");
              }
              tailHash = (tailEvent as { eventHash: string }).eventHash;
            } catch {
              return Response.json({ error: "audit log corrupt" }, { status: 500 });
            }
            nextSeq = tailRow.seq + 1;
          }
          const countMeasured = this.store().exec<{ n: number }>(STMT_AUDIT_TABLE_COUNT);
          rowsRead += countMeasured.rowsRead;
          rowsWritten += countMeasured.rowsWritten;
          const stored = countMeasured.rows[0]?.n ?? 0;
          if (stored >= totalCap) {
            // Same bound, same signal as the segments branch:
            // the client reports AUDIT_STORE_FULL, fail-visible,
            // and no evidence is deleted.
            return Response.json({
              storeFull: true,
              rowsRead,
              rowsWritten,
              statement: STMT_AUDIT_TABLE_COUNT,
            });
          }
          const unsigned = {
            ...auditEventFromInput(input),
            id: crypto.randomUUID(),
            previousEventHash: tailHash,
          };
          const event: IaaaAuditEvent = {
            ...unsigned,
            eventHash: await computeEventHash(unsigned),
          };
          const inserted = this.store().exec(STMT_AUDIT_TABLE_INSERT, nextSeq, JSON.stringify(event));
          rowsRead += inserted.rowsRead;
          rowsWritten += inserted.rowsWritten;
          return Response.json({
            ok: true,
            event,
            rowsRead,
            rowsWritten,
            statement: STMT_AUDIT_TABLE_INSERT,
          });
        }

        let rowsRead = 0;
        let rowsWritten = 0;
        const liveMeasured = this.store().exec<{ value: string }>(STMT_POINT_GET, ns, key);
        rowsRead += liveMeasured.rowsRead;
        rowsWritten += liveMeasured.rowsWritten;
        const liveRow = liveMeasured.rows[0];
        let live: IaaaAuditEvent[];
        if (!liveRow) {
          live = [];
        } else {
          try {
            const parsed: unknown = JSON.parse(liveRow.value);
            if (!Array.isArray(parsed)) throw new Error("not an array");
            live = parsed as IaaaAuditEvent[];
          } catch {
            // Corrupt evidence is never overwritten: fail loud and
            // leave the bytes untouched for investigation.
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
        }
        const archiveMeasured = this.store().exec<{ key: string; value: string }>(
          STMT_ARCHIVE_LIST,
          ns,
          `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}%`,
        );
        rowsRead += archiveMeasured.rowsRead;
        rowsWritten += archiveMeasured.rowsWritten;
        const segments: IaaaAuditEvent[][] = [];
        let nextSegmentIndex = 0;
        for (const row of archiveMeasured.rows) {
          const suffix = row.key.slice(IAAA_AUDIT_ARCHIVE_KEY_PREFIX.length);
          const parsedIndex = Number.parseInt(suffix, 10);
          if (Number.isInteger(parsedIndex)) nextSegmentIndex = Math.max(nextSegmentIndex, parsedIndex + 1);
          try {
            const parsed: unknown = JSON.parse(row.value);
            if (!Array.isArray(parsed)) throw new Error("not an array");
            segments.push(parsed as IaaaAuditEvent[]);
          } catch {
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
        }
        const archivedCount = segments.reduce((sum, seg) => sum + seg.length, 0);
        if (live.length + archivedCount >= totalCap) {
          // The bound is enforced, never silently exceeded and never
          // met by deleting evidence: the client reports
          // AUDIT_STORE_FULL, fail-visible. Destructive retention
          // (deleting old events) needs the Q7 retention decision
          // (owner Mubasher), which has not been made — see the
          // #1760 slice doc.
          return Response.json({
            storeFull: true,
            rowsRead,
            rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
        const lastArchived =
          segments.length > 0 && segments[segments.length - 1].length > 0
            ? segments[segments.length - 1][segments[segments.length - 1].length - 1]
            : null;
        const previousEventHash =
          live.length > 0
            ? live[live.length - 1].eventHash
            : lastArchived
              ? lastArchived.eventHash
              : null;
        const unsigned = {
          ...auditEventFromInput(input),
          id: crypto.randomUUID(),
          previousEventHash,
        };
        const event: IaaaAuditEvent = {
          ...unsigned,
          eventHash: await computeEventHash(unsigned),
        };
        live.push(event);
        // Rotation preserves evidence: the oldest segment moves to
        // a new archive key; nothing is deleted. The live key stays
        // bounded at liveMax, the whole store at totalCap.
        while (live.length > liveMax) {
          const segment = live.splice(0, segmentSize);
          const segmentKey = `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}${String(nextSegmentIndex).padStart(6, "0")}`;
          nextSegmentIndex += 1;
          const inserted = this.store().exec(STMT_ARCHIVE_INSERT, ns, segmentKey, JSON.stringify(segment));
          rowsRead += inserted.rowsRead;
          rowsWritten += inserted.rowsWritten;
        }
        const written = this.store().exec(STMT_UPSERT, ns, key, JSON.stringify(live), null);
        rowsRead += written.rowsRead;
        rowsWritten += written.rowsWritten;
        return Response.json({
          ok: true,
          event,
          rowsRead,
          rowsWritten,
          statement: STMT_UPSERT,
        });
      }

      if (op === "audit-list") {
        // #3251 (O1) — list the IAAA chain for the flag-ON
        // composition. One op, server-side substrate selection:
        // table rows while the table holds any (the migrated /
        // live chain), else the segment entries (pre-migration
        // bytes, legacy shape included) — so bytes written
        // before the cutover read identically. A corrupt row or
        // segment fails loud with no partial evidence; the stale
        // segment bytes behind a populated table are never
        // parsed (they are retained, not live).
        if (ns !== "sessions" || key !== IAAA_AUDIT_LOG_KEY) {
          return Response.json(
            { error: "audit-list is restricted to the sessions audit log key" },
            { status: 400 },
          );
        }
        let rowsRead = 0;
        let rowsWritten = 0;
        const countMeasured = this.store().exec<{ n: number }>(STMT_AUDIT_TABLE_COUNT);
        rowsRead += countMeasured.rowsRead;
        rowsWritten += countMeasured.rowsWritten;
        if ((countMeasured.rows[0]?.n ?? 0) > 0) {
          const listed = this.store().exec<{ seq: number; event_json: string }>(STMT_AUDIT_TABLE_LIST);
          rowsRead += listed.rowsRead;
          rowsWritten += listed.rowsWritten;
          // Raw rows, unparsed: the client parses each event
          // JSON and throws the corrupt error — the same split
          // as the old `list` op, so a corrupt row surfaces as
          // the corrupt error at the port, not a generic read
          // failure.
          return Response.json({
            entries: listed.rows.map((row) => ({
              key: `${IAAA_AUDIT_TABLE_KEY_PREFIX}${String(row.seq).padStart(6, "0")}`,
              value: row.event_json,
            })),
            rowsRead,
            rowsWritten,
            statement: STMT_AUDIT_TABLE_LIST,
          });
        }
        const listed = this.store().exec<{ key: string; value: string }>(
          STMT_LIST,
          ns,
          `${IAAA_AUDIT_KEY_PREFIX.replace(/[\\%_]/g, "\\$&")}%`,
          Date.now(),
        );
        rowsRead += listed.rowsRead;
        rowsWritten += listed.rowsWritten;
        return Response.json({
          entries: listed.rows,
          rowsRead,
          rowsWritten,
          statement: STMT_LIST,
        });
      }

      if (op === "audit-migrate") {
        // #3251 (O1) — explicit migration of the segment bytes
        // into the append-only table: the cutover tool (the
        // table-append branch migrates lazily the same way, so
        // the flag can flip before or after this runs).
        // Idempotent: a populated table migrates nothing.
        if (ns !== "sessions" || key !== IAAA_AUDIT_LOG_KEY) {
          return Response.json(
            { error: "audit-migrate is restricted to the sessions audit log key" },
            { status: 400 },
          );
        }
        let migration: {
          migrated: number;
          alreadyMigrated: boolean;
          rowsRead: number;
          rowsWritten: number;
        };
        try {
          migration = this.migrateSegmentsToTable();
        } catch {
          return Response.json({ error: "audit log corrupt" }, { status: 500 });
        }
        return Response.json({
          ok: true,
          migrated: migration.migrated,
          alreadyMigrated: migration.alreadyMigrated,
          rowsRead: migration.rowsRead,
          rowsWritten: migration.rowsWritten,
          statement: STMT_AUDIT_TABLE_INSERT,
        });
      }

      if (op === "put") {
        if (typeof body.value !== "string") {
          return Response.json({ error: "value is required for put" }, { status: 400 });
        }
        const expiresAt = typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        const measured = this.store().exec(STMT_UPSERT, ns, key, body.value, expiresAt);
        return Response.json({
          ok: true,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_UPSERT,
        });
      }

      const deleted = this.store().exec(STMT_DELETE, ns, key);
      return Response.json({
        ok: true,
        rowsRead: deleted.rowsRead,
        rowsWritten: deleted.rowsWritten,
        statement: STMT_DELETE,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // #3515 S3 batch 8 — the DO's own env wires the sink to the
      // Analytics Engine dataset; test instances built via
      // Object.create (no constructor, no env) fall back to the
      // structured console sink (never an empty-env sink, #5587).
      const structuredLog = createStructuredLogger(
        this.env ? createObservabilitySink(this.env) : new ConsoleObservabilitySink(),
        { component: "security/sessionStore" },
      );
      structuredLog.error("sessionStore.op_failed", {
        message: "[SessionStore] op failed",
        op,
        error: message,
      });
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
