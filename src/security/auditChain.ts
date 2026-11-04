import type { AuditEvent } from "../types";

/**
 * Issue #2178 (Q7 S1) — tamper-evident chain on live mas_events.
 *
 * Mirrors the scheme in src/security/iaaaAudit.ts (SHA-256 hash chain:
 * each row carries the previous row's hash and its own hash over a
 * canonical serialization), adapted to the live mas_events row shape.
 * Two deliberate differences from iaaaAudit.ts:
 * - Sync: the live mas_events writer (orm.events.create) is sync, and
 *   every existing sha256Hex in the repo is async WebCrypto, so this
 *   module vendors a dependency-free sync SHA-256 (FIPS 180-4),
 *   proven against NIST vectors in tests/audit_chain_2178.test.ts.
 * - Stored payload: canonicalization uses the payload TEXT as stored
 *   (recordAudit stringifies; the chained writer does the same), so
 *   verification recomputes from exactly what the DB returns.
 *
 * Pre-chain rows (no eventHash, from before chaining) are a genesis
 * boundary: verification skips them and starts at the first hashed
 * row, which must have previousEventHash null. A missing hash AFTER
 * chaining has started fails verification — a gap is tampering or
 * loss, never a second genesis.
 */

export interface AuditChainRow {
  id: string;
  sessionId: string;
  type: string;
  agent: string;
  /** Payload TEXT as stored (JSON string). */
  payload: string;
  createdAt: string;
  previousEventHash: string | null;
  eventHash: string;
}

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Synchronous SHA-256 (FIPS 180-4), hex digest. Input is UTF-8 text. */
export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length; messages here are far below 2^32 bits.
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** Canonical serialization: defined fields only, in fixed key order. */
export function canonicalizeAuditRow(row: Omit<AuditChainRow, "eventHash">): string {
  return JSON.stringify([
    ["id", row.id],
    ["sessionId", row.sessionId],
    ["type", row.type],
    ["agent", row.agent],
    ["payload", row.payload],
    ["createdAt", row.createdAt],
    ["previousEventHash", row.previousEventHash],
  ]);
}

/** Link one row onto a chain: previous hash in, own hash computed. */
export function linkAuditRow(
  row: Omit<AuditChainRow, "previousEventHash" | "eventHash">,
  previousEventHash: string | null,
): AuditChainRow {
  const withPrev = { ...row, previousEventHash };
  return { ...withPrev, eventHash: sha256HexSync(canonicalizeAuditRow(withPrev)) };
}

/**
 * Issue #2178 (Q7 S2) — blocking audit write for consequential actions.
 *
 * The live writer (orm.events.create, ChainedAuditRepository) already
 * throws on a failed insert; what makes a write "blocking" is that
 * the caller does NOT catch it. This helper is that contract, named:
 * it writes through the chained repository and lets any failure
 * propagate, so the caller must not report success for an action
 * whose own audit write failed. Contrast the warn-and-swallow paths
 * (OrchestratorAgent.audit, ScheduledTasksService.audit), which stay
 * for non-consequential writes per #1999 D1 (D1 governs the run,
 * S2 governs the action).
 */
export interface BlockingAuditEvents {
  create(record: AuditEvent): AuditEvent;
}

export function recordBlockingAudit(
  events: BlockingAuditEvents,
  record: AuditEvent,
): AuditEvent {
  // Deliberately no try/catch: swallowing here would silently
  // un-block every consequential action wired through this helper.
  return events.create(record);
}

/** First break of a mas_events chain, for the #3156 alert path. */
export interface AuditChainDiagnosis {
  valid: boolean;
  /** Index into the input rows array of the first broken row, or null when valid. */
  brokenIndex: number | null;
  /** Human-readable reason for the first break, or null when valid. */
  reason: string | null;
}

/**
 * Diagnose rows in insertion order. Same walk as verifyAuditChain:
 * pre-chain rows (empty eventHash) before the first hashed row are
 * skipped as a genesis boundary; the first hashed row must have
 * previousEventHash null, every later row must link to its
 * predecessor, and every hash must recompute. The first break is
 * reported with its index so the tamper-response runbook can name
 * the affected range; appending an alert onto a broken tail never
 * repairs the break, so the diagnosis is stable across alerts.
 */
export function diagnoseAuditChain(rows: AuditChainRow[]): AuditChainDiagnosis {
  let previousHash: string | null = null;
  let chaining = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!chaining) {
      if (!row.eventHash) continue;
      chaining = true;
    }
    if (!row.eventHash) {
      return { valid: false, brokenIndex: i, reason: "missing eventHash after chaining started (bypass writer or deleted hash)" };
    }
    if (row.previousEventHash !== previousHash) {
      return { valid: false, brokenIndex: i, reason: "previousEventHash mismatch (predecessor modified, deleted, or reordered)" };
    }
    const { eventHash, ...rest } = row;
    if (sha256HexSync(canonicalizeAuditRow(rest)) !== eventHash) {
      return { valid: false, brokenIndex: i, reason: "eventHash recomputation mismatch (row payload modified)" };
    }
    previousHash = eventHash;
  }
  return { valid: true, brokenIndex: null, reason: null };
}

/**
 * Verify rows in insertion order. Pre-chain rows (empty eventHash)
 * before the first hashed row are skipped as a genesis boundary; the
 * first hashed row must have previousEventHash null, every later row
 * must link to its predecessor, and every hash must recompute.
 */
export function verifyAuditChain(rows: AuditChainRow[]): boolean {
  return diagnoseAuditChain(rows).valid;
}
