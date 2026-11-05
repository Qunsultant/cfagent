/**
 * Issue #2435 (#1976 step 5d) — the in-memory adapter for
 * the audit log family (conformance / test doubles). It
 * mirrors the SessionStore DO's `audit-append` op over its
 * own map — same caps, same clamps to the hard ceilings,
 * same rotation, same storeFull signal, same corrupt-bytes
 * refusal — the shape tests/fake-session-store.ts already
 * uses to double the DO, carried into the layer.
 *
 * One deliberate difference from a naive map mirror:
 * appends are serialized through a promise chain. The real
 * DO processes one request at a time (its input gate is
 * what makes the op atomic); without serialization, two
 * parallel appends here would interleave at the hashing
 * await and fork the chain — claiming the mirror is
 * equivalent while dropping the property that matters most.
 * The chain models the gate, nothing more.
 *
 * `seedRaw` / `rawValue` are test seams for seeding and
 * inspecting stored bytes (corrupt segments, legacy-shape
 * logs) — they are on the class, not on the port contract.
 *
 * #CDO-mha7
 */
import {
  computeEventHash,
  type AuditResult,
  type CreateIaaaAuditEventInput,
  type IaaaAuditEvent,
} from "../security/iaaaAudit";
import type { StoreReply } from "./durableKv";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_DEFAULT_LIVE_MAX,
  IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS,
  IAAA_AUDIT_DEFAULT_SEGMENT_SIZE,
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
  type AuditLogPort,
  type AuditLogPortOptions,
} from "./auditLogPorts";
import {
  createAuditLogStore,
  type AuditLogBackend,
} from "./auditLogStoreImpl";

export class InMemoryAuditLogAdapter implements AuditLogPort {
  readonly legacyFallback = false as const;
  private readonly rows = new Map<string, string>();
  private readonly store: AuditLogPort;
  private gate: Promise<unknown> = Promise.resolve();

  constructor(options: AuditLogPortOptions = {}) {
    const backend: AuditLogBackend = {
      configured: true,
      sendAppend: (payload) => {
        const run = this.gate.then(() => this.opAppend(payload));
        this.gate = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      listEntries: async () => {
        const out: Array<{ key: string; value: string }> = [];
        for (const [key, value] of this.rows) {
          if (key.startsWith(IAAA_AUDIT_KEY_PREFIX)) out.push({ key, value });
        }
        out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return out;
      },
    };
    this.store = createAuditLogStore(backend, options);
  }

  append(event: IaaaAuditEvent): Promise<void> {
    return this.store.append(event);
  }

  appendAtomic(input: CreateIaaaAuditEventInput): Promise<AuditResult> {
    return this.store.appendAtomic!(input);
  }

  list(): Promise<IaaaAuditEvent[]> {
    return this.store.list();
  }

  /** Test seam: seed raw stored bytes under an audit key. */
  seedRaw(key: string, value: string): void {
    this.rows.set(key, value);
  }

  /** Test seam: read raw stored bytes under an audit key. */
  rawValue(key: string): string | null {
    return this.rows.get(key) ?? null;
  }

  /** The audit-append op mirror (see header). */
  private async opAppend(
    payload: Record<string, unknown>,
  ): Promise<StoreReply | null> {
    const clamp = (v: unknown, hard: number): number =>
      typeof v === "number" && Number.isInteger(v) && v > 0
        ? Math.min(v, hard)
        : hard;
    const liveMax = clamp(payload.liveMax, IAAA_AUDIT_DEFAULT_LIVE_MAX);
    const segmentSize = clamp(
      payload.segmentSize,
      IAAA_AUDIT_DEFAULT_SEGMENT_SIZE,
    );
    const maxSegments = clamp(
      payload.maxArchiveSegments,
      IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS,
    );
    if (payload.key !== IAAA_AUDIT_LOG_KEY) {
      return { error: "audit-append is restricted" };
    }
    const parseArray = (raw: string | undefined): IaaaAuditEvent[] | null => {
      if (raw === undefined) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as IaaaAuditEvent[]) : null;
      } catch {
        return null;
      }
    };
    const live = parseArray(this.rows.get(IAAA_AUDIT_LOG_KEY));
    if (live === null) return { error: "audit log corrupt" };
    const archiveKeys = [...this.rows.keys()]
      .filter((k) => k.startsWith(IAAA_AUDIT_ARCHIVE_KEY_PREFIX))
      .sort();
    const segments: IaaaAuditEvent[][] = [];
    for (const ak of archiveKeys) {
      const seg = parseArray(this.rows.get(ak));
      if (seg === null) return { error: "audit log corrupt" };
      segments.push(seg);
    }
    const archived = segments.reduce((sum, seg) => sum + seg.length, 0);
    if (live.length + archived >= liveMax + maxSegments * segmentSize) {
      return { storeFull: true };
    }
    const input = JSON.parse(
      typeof payload.value === "string" ? payload.value : "",
    ) as Omit<IaaaAuditEvent, "id" | "previousEventHash" | "eventHash">;
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
    const unsigned = { ...input, id: crypto.randomUUID(), previousEventHash };
    const event: IaaaAuditEvent = {
      ...unsigned,
      eventHash: await computeEventHash(unsigned),
    };
    live.push(event);
    let nextIndex = archiveKeys.length;
    while (live.length > liveMax) {
      const segment = live.splice(0, segmentSize);
      this.rows.set(
        `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}${String(nextIndex).padStart(6, "0")}`,
        JSON.stringify(segment),
      );
      nextIndex += 1;
    }
    this.rows.set(IAAA_AUDIT_LOG_KEY, JSON.stringify(live));
    return { ok: true, event };
  }
}
