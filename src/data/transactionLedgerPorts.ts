/**
 * src/data/transactionLedgerPorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the mas_transactions port — the payment
 * ledger. DO residency (D-0 (a),(b),(e)): the ledger is
 * per-instance agent state; the cross-DO ledger write the
 * survey flagged stays as-is in this slice (named residual).
 *
 * Beyond the generic contract, the port carries replace():
 * INSERT OR REPLACE, the draft-payment write the MAS
 * draftPayment tool used to run as a raw statement in
 * agents/mas.ts (audit V-2's sibling write). The tool's
 * status transitions (completed / rejected) go through the
 * generic update() — the raw UPDATE bypasses named in the
 * audit are retired by this port.
 *
 * #2360 (step 4d-2, audit R-2): the payments route's four
 * status transitions join the port as named operations —
 * the generic update() cannot express them without changing
 * semantics (it skips undefined fields, verifies by re-read,
 * and has no OR-WHERE form). Each operation carries EXACTLY
 * the legacy statement's field set and WHERE shape, no
 * status guard is added (the legacy UPDATEs have none —
 * pinned as found), and each returns the number of rows the
 * UPDATE matched, read from the cursor's rowsWritten
 * exactly as the async-job adapter reads its transitions
 * (the route ignores the count; conformance pins it). The
 * route's draft read is the generic findById.
 *
 * #CDO-mha7
 */
import type { TransactionRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

/**
 * The field set of the immediate-confirm completion
 * (status + gateway_ref + checkout_url + authorizer_did +
 * note + updated_at, by id) — verbatim from the legacy
 * statement in routes/payments.ts.
 */
export interface TransactionCompletionFields {
  gatewayRef: string;
  checkoutUrl: string;
  authorizerDid: string;
  note: string;
  updatedAt: string;
}

/**
 * The field set of the immediate-confirm rejection
 * (status + authorizer_did + note + updated_at, by id).
 */
export interface TransactionRejectionFields {
  authorizerDid: string;
  note: string;
  updatedAt: string;
}

export interface TransactionLedgerPort
  extends RepositoryPort<TransactionRecord> {
  /** INSERT OR REPLACE the full record; returns the record. */
  replace(record: TransactionRecord): TransactionRecord;
  /**
   * Tenant-scoped read (#3182): rows whose tenant_id equals the
   * requested tenant, newest first. Null-tenant legacy rows are
   * EXCLUDED — they carry no tenant attribution and must never
   * leak into a tenant's view; they stay reachable via the
   * unfiltered findMany and via the audit-payload join (which
   * attributes by run id, not by tenant_id). A tenant with no
   * rows gets an empty array.
   */
  findByTenant(tenantId: string): TransactionRecord[];
  /**
   * The immediate-confirm completion: SET status='completed'
   * with the gateway fields, WHERE id = ?. No status guard.
   * Returns rows matched.
   */
  completeWithGateway(id: string, fields: TransactionCompletionFields): number;
  /**
   * The immediate-confirm rejection: SET status='rejected'
   * with authorizer + note, WHERE id = ?. No status guard.
   * Returns rows matched.
   */
  rejectWithNote(id: string, fields: TransactionRejectionFields): number;
  /**
   * The capture completion: SET status='completed',
   * updated_at, WHERE id = ? OR gateway_ref = ? (the same
   * reference bound twice — one call can settle two rows).
   * No status guard. Returns rows matched.
   */
  completeByIdOrGatewayRef(ref: string, updatedAt: string): number;
  /**
   * The webhook settlement completion: SET status=
   * 'completed', updated_at, WHERE id = ?. No status guard.
   * Returns rows matched.
   */
  completeById(id: string, updatedAt: string): number;
}
