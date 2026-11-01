/**
 * Issue #2155 ([Ledger] Minimal double-entry journal, sub-issue of
 * #2012) — journal port.
 *
 * The repo has no chart of accounts: money lives as single-entry
 * rows in DO `mas_transactions` plus D1 balances and claim rows.
 * This journal is the MINIMAL double-entry projection of those
 * ledger events, designed TO BE REPLACED by a real general-ledger
 * system (Kill Bill / Fineract / ERPNext): the journal sits behind
 * this port with a D1 adapter now, so a future GL adapter swaps in
 * behind the same port without touching callers.
 *
 * Authority: the DO ledger stays authoritative for payments. The
 * journal is a D1 projection (ADR 0002 / #1546 philosophy: DO
 * authoritative, D1 projection; projection failure never fails
 * the execution transition — callers post best-effort, see
 * src/services/journalPosting.ts).
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the port interface, and pure helpers ONLY. It imports no store
 * client, references no env binding, and writes no SQL. All
 * query-builder code lives in d1JournalAdapter.ts; the in-memory
 * adapter shares the validators below so the two implementations
 * cannot drift. A structural test pins the import rule.
 *
 * Invariants (enforced by every adapter, tested by the port
 * conformance suite against both adapters):
 *  - For each transactionRef, sum(debits) == sum(credits) or the
 *    post throws (validated BEFORE any write).
 *  - Replaying the same transactionRef is a no-op (the DO ledger
 *    row is the audit; the journal follows INSERT OR IGNORE
 *    semantics, mirroring the commercial claim precedent).
 *  - Every entry carries tenantId; a post spans exactly one
 *    tenant; trial balance is per tenant; entries never cross
 *    tenants (tenant mismatch throws).
 *  - Journal rows live ONLY in D1. Never in mas_transactions,
 *    never action "micropayment" (BudgetGuard isolation).
 */

export type JournalAccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface JournalAccount {
  code: string;
  name: string;
  type: JournalAccountType;
}

/**
 * Minimal chart, seeded in the ensure-schema path. Family is
 * carried on the entry row, NOT as subaccounts. Account 5000 is
 * RESERVED for the refunds design (#2147): seeded, with no
 * mapping writing to it yet. 5000 is contra-revenue; the
 * constrained type enum has no contra-income value, so it maps
 * to "expense" — the name carries the semantics. Account 2100
 * (Deferred revenue, liability) is written by the subscription
 * purchase mapping (#2155 follow-up): a purchase is NOT
 * immediate revenue. The RECOGNITION schedule (deferred →
 * earned over the subscription period) is a FOLLOW-UP slice,
 * deliberately not built here: no periodic recognition sweeper,
 * no cron, no earned-revenue amortization logic in this slice.
 */
export const MINIMAL_CHART: readonly JournalAccount[] = [
  { code: "1000", name: "Funds received", type: "asset" },
  { code: "2000", name: "Customer credits outstanding", type: "liability" },
  { code: "2100", name: "Deferred revenue", type: "liability" },
  { code: "4000", name: "Revenue — screener runs", type: "income" },
  { code: "5000", name: "Refunds contra-revenue", type: "expense" },
];

export const JOURNAL_ACCOUNT_CODES: ReadonlySet<string> = new Set(
  MINIMAL_CHART.map((a) => a.code),
);

export interface JournalEntry {
  id: string;
  transactionRef: string;
  accountCode: string;
  debitUSD: number;
  creditUSD: number;
  currency: string;
  tenantId: string;
  runRequestId: string;
  family: string;
  createdAtMs: number;
}

/**
 * Caller-supplied entry; id/createdAtMs are adapter-assigned.
 *
 * transactionRef is the POSTING idempotency key, and it must be
 * unique per ledger event — NOT merely per run. A failed paid run
 * produces two ledger events under one runRequestId (a charge and
 * a failure credit), so the convention is: charge →
 * runRequestId; failure credit → `${runRequestId}:credit`;
 * redemption → the redeemed run's runRequestId. runRequestId
 * stays the run the entry belongs to; transactionRef is the
 * event that posted it. (The DO ledger row id would also serve;
 * the wiring call sites know the runRequestId, not the row id.)
 */
export interface JournalEntryInput {
  transactionRef: string;
  accountCode: string;
  debitUSD: number;
  creditUSD: number;
  currency: string;
  tenantId: string;
  runRequestId: string;
  family: string;
}

export interface JournalPort {
  /**
   * Post a balanced set of entries for one transactionRef.
   * Throws on an unbalanced set, a multi-tenant set, an unknown
   * account, or an invalid amount — before writing anything.
   * Replaying an already-posted transactionRef returns the
   * existing entries without writing. #1761: replay is
   * tenant-scoped — a replay under a DIFFERENT tenant throws
   * (fail closed) instead of returning the first tenant's
   * entries or silently dropping the write on the tenant-blind
   * entry id.
   */
  postEntries(entries: JournalEntryInput[]): Promise<JournalEntry[]>;
  /** All entries for one tenant, oldest first. No unscoped read. */
  listEntries(tenantId: string): Promise<JournalEntry[]>;
  /**
   * Entries for one transactionRef IN one tenant (#1761: the
   * pre-fix read took no tenant and returned any tenant's rows
   * for the ref, so a replay post in another tenant was
   * short-circuited by the first tenant's entries. A blank
   * tenant throws; a mismatched tenant reads tenant-empty).
   */
  getEntriesByRef(transactionRef: string, tenantId: string): Promise<JournalEntry[]>;
  /** The seeded chart, ordered by code. */
  listAccounts(): Promise<JournalAccount[]>;
}

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Deterministic entry id: one entry per (transaction, account). */
export function journalEntryId(transactionRef: string, accountCode: string): string {
  return `${transactionRef}:${accountCode}`;
}

function assertJournalAmount(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Journal ${field} must be a finite non-negative number.`);
  }
  return round2(n);
}

/**
 * Shared post validation for both adapters: exactly one nonzero
 * side per entry, one transactionRef, one tenant, one currency,
 * known accounts, balanced totals. Throws before any write.
 */
export function assertBalancedPost(entries: JournalEntryInput[]): void {
  if (entries.length === 0) {
    throw new Error("Journal post requires at least one entry.");
  }
  const refs = new Set(entries.map((e) => e.transactionRef));
  if (refs.size !== 1) {
    throw new Error("Journal post must span exactly one transactionRef.");
  }
  const tenants = new Set(entries.map((e) => e.tenantId));
  if (tenants.size !== 1 || !entries[0].tenantId) {
    throw new Error("Journal post must span exactly one tenant.");
  }
  const currencies = new Set(entries.map((e) => e.currency));
  if (currencies.size !== 1 || !entries[0].currency) {
    throw new Error("Journal post must span exactly one currency.");
  }
  let debits = 0;
  let credits = 0;
  for (const e of entries) {
    if (!e.runRequestId || !e.family) {
      throw new Error("Journal entries require runRequestId and family.");
    }
    if (!JOURNAL_ACCOUNT_CODES.has(e.accountCode)) {
      throw new Error(`Unknown journal account: ${e.accountCode}.`);
    }
    const debit = assertJournalAmount(e.debitUSD, "debitUSD");
    const credit = assertJournalAmount(e.creditUSD, "creditUSD");
    if ((debit === 0) === (credit === 0)) {
      throw new Error(
        `Journal entry for account ${e.accountCode} must have exactly one nonzero side.`,
      );
    }
    debits = round2(debits + debit);
    credits = round2(credits + credit);
  }
  if (debits !== credits) {
    throw new Error(
      `Unbalanced journal post for ${entries[0].transactionRef}: debits ${debits} != credits ${credits}.`,
    );
  }
}

export interface JournalMappingInput {
  /** Idempotency key: the ledger row's runRequestId. */
  transactionRef: string;
  tenantId: string;
  runRequestId: string;
  family: string;
  /** The ledger row amount. */
  amountUSD: number;
  currency?: string;
}

function assertMappingAmount(input: JournalMappingInput): number {
  const amount = round2(input.amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Journal mapping requires a positive finite amountUSD.");
  }
  if (!input.transactionRef || !input.tenantId || !input.runRequestId || !input.family) {
    throw new Error("Journal mapping requires transactionRef, tenantId, runRequestId, and family.");
  }
  return amount;
}

/** charge → Dr 1000 / Cr 4000. */
export function mapChargeToJournalEntries(input: JournalMappingInput): JournalEntryInput[] {
  const amount = assertMappingAmount(input);
  const currency = input.currency ?? "USD";
  return [
    {
      transactionRef: input.transactionRef,
      accountCode: "1000",
      debitUSD: amount,
      creditUSD: 0,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
    {
      transactionRef: input.transactionRef,
      accountCode: "4000",
      debitUSD: 0,
      creditUSD: amount,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
  ];
}

/** failure credit issued → Dr 4000 / Cr 2000. */
export function mapFailureCreditToJournalEntries(input: JournalMappingInput): JournalEntryInput[] {
  const amount = assertMappingAmount(input);
  const currency = input.currency ?? "USD";
  return [
    {
      transactionRef: input.transactionRef,
      accountCode: "4000",
      debitUSD: amount,
      creditUSD: 0,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
    {
      transactionRef: input.transactionRef,
      accountCode: "2000",
      debitUSD: 0,
      creditUSD: amount,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
  ];
}

/**
 * Subscription purchase journal input. Distinct from
 * JournalMappingInput on purpose: a subscription has no
 * screener run and no screener family, so the caller supplies
 * the subscription id and the mapping stamps it into the
 * runRequestId column (the entry row's reference column, which
 * is NOT NULL in the journal schema) with family
 * "subscription". transactionRef is the purchase's
 * idempotency key: the checkoutRequestId (the route-minted
 * "sub-" draft id, also the activation replay-guard key), so
 * a replayed purchase activation can never double-post — the
 * adapter returns the existing entries for that ref.
 */
export interface SubscriptionPurchaseJournalInput {
  /** Idempotency key: the purchase checkoutRequestId ("sub-" draft id). */
  transactionRef: string;
  tenantId: string;
  /** The created subscription record id (carried in runRequestId). */
  subscriptionId: string;
  /** The plan price at purchase. */
  amountUSD: number;
  currency?: string;
}

/** subscription purchase → Dr 1000 / Cr 2100. NOT immediate revenue. */
export function mapSubscriptionPurchaseToJournalEntries(
  input: SubscriptionPurchaseJournalInput,
): JournalEntryInput[] {
  const amount = round2(input.amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Journal mapping requires a positive finite amountUSD.");
  }
  if (!input.transactionRef || !input.tenantId || !input.subscriptionId) {
    throw new Error(
      "Journal mapping requires transactionRef, tenantId, and subscriptionId.",
    );
  }
  const currency = input.currency ?? "USD";
  return [
    {
      transactionRef: input.transactionRef,
      accountCode: "1000",
      debitUSD: amount,
      creditUSD: 0,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.subscriptionId,
      family: "subscription",
    },
    {
      transactionRef: input.transactionRef,
      accountCode: "2100",
      debitUSD: 0,
      creditUSD: amount,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.subscriptionId,
      family: "subscription",
    },
  ];
}

/** redemption (replacement run delivered) → Dr 2000 / Cr 4000. */
export function mapRedemptionToJournalEntries(input: JournalMappingInput): JournalEntryInput[] {
  const amount = assertMappingAmount(input);
  const currency = input.currency ?? "USD";
  return [
    {
      transactionRef: input.transactionRef,
      accountCode: "2000",
      debitUSD: amount,
      creditUSD: 0,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
    {
      transactionRef: input.transactionRef,
      accountCode: "4000",
      debitUSD: 0,
      creditUSD: amount,
      currency,
      tenantId: input.tenantId,
      runRequestId: input.runRequestId,
      family: input.family,
    },
  ];
}

export interface TrialBalanceAccount {
  code: string;
  name: string;
  type: JournalAccountType;
  debitTotal: number;
  creditTotal: number;
}

export interface TrialBalance {
  tenantId: string;
  accounts: TrialBalanceAccount[];
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}

/** Trial balance over the port: per-account totals for one tenant plus a balanced flag. */
export async function trialBalance(port: JournalPort, tenantId: string): Promise<TrialBalance> {
  const [entries, accounts] = await Promise.all([
    port.listEntries(tenantId),
    port.listAccounts(),
  ]);
  const byCode = new Map<string, TrialBalanceAccount>();
  for (const a of accounts) {
    byCode.set(a.code, { code: a.code, name: a.name, type: a.type, debitTotal: 0, creditTotal: 0 });
  }
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of entries) {
    const row = byCode.get(e.accountCode);
    if (!row) continue;
    row.debitTotal = round2(row.debitTotal + e.debitUSD);
    row.creditTotal = round2(row.creditTotal + e.creditUSD);
    totalDebits = round2(totalDebits + e.debitUSD);
    totalCredits = round2(totalCredits + e.creditUSD);
  }
  return {
    tenantId,
    accounts: [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
    totalDebits,
    totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

export interface JournalReconcileReport {
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
  matchedRefs: string[];
  mismatched: Array<{ transactionRef: string; reasons: string[] }>;
  /** Balanced journal-only refs (e.g. redemptions, which have no ledger row by design). */
  journalOnlyBalancedRefs: string[];
}

/**
 * PURE reconcile: journal entries against ledger rows. No
 * auto-correction, no store reads. A ledger ref may carry several
 * ledger rows (a failed paid run has both a charge and a credit
 * row under one runRequestId), so the per-ref check compares
 * journal totals against the SUM of that ref's ledger amounts.
 * A balanced journal-only ref is reported, not a mismatch:
 * redemptions post to the journal with no corresponding ledger
 * row, by design.
 */
export function reconcileJournal(
  ledgerRows: Array<{ transactionRef: string; amountUSD: number }>,
  journalEntries: JournalEntry[],
): JournalReconcileReport {
  const ledgerByRef = new Map<string, number>();
  for (const row of ledgerRows) {
    ledgerByRef.set(
      row.transactionRef,
      round2((ledgerByRef.get(row.transactionRef) ?? 0) + row.amountUSD),
    );
  }
  const journalByRef = new Map<string, JournalEntry[]>();
  for (const e of journalEntries) {
    const list = journalByRef.get(e.transactionRef) ?? [];
    list.push(e);
    journalByRef.set(e.transactionRef, list);
  }
  const matchedRefs: string[] = [];
  const mismatched: Array<{ transactionRef: string; reasons: string[] }> = [];
  const journalOnlyBalancedRefs: string[] = [];
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of journalEntries) {
    totalDebits = round2(totalDebits + e.debitUSD);
    totalCredits = round2(totalCredits + e.creditUSD);
  }
  for (const [ref, expected] of ledgerByRef) {
    const entries = journalByRef.get(ref) ?? [];
    const reasons: string[] = [];
    if (entries.length === 0) {
      reasons.push("no journal entries");
    } else {
      const debits = round2(entries.reduce((s, e) => s + e.debitUSD, 0));
      const credits = round2(entries.reduce((s, e) => s + e.creditUSD, 0));
      if (debits !== credits) reasons.push(`unbalanced journal: debits ${debits} != credits ${credits}`);
      if (debits !== round2(expected)) reasons.push(`journal debits ${debits} != ledger amount ${round2(expected)}`);
      if (credits !== round2(expected)) reasons.push(`journal credits ${credits} != ledger amount ${round2(expected)}`);
    }
    if (reasons.length === 0) matchedRefs.push(ref);
    else mismatched.push({ transactionRef: ref, reasons });
  }
  for (const [ref, entries] of journalByRef) {
    if (ledgerByRef.has(ref)) continue;
    const debits = round2(entries.reduce((s, e) => s + e.debitUSD, 0));
    const credits = round2(entries.reduce((s, e) => s + e.creditUSD, 0));
    if (debits !== credits) {
      mismatched.push({
        transactionRef: ref,
        reasons: [`journal-only and unbalanced: debits ${debits} != credits ${credits}`],
      });
    } else {
      journalOnlyBalancedRefs.push(ref);
    }
  }
  return {
    totalDebits,
    totalCredits,
    balanced: mismatched.length === 0,
    matchedRefs: matchedRefs.sort(),
    mismatched,
    journalOnlyBalancedRefs: journalOnlyBalancedRefs.sort(),
  };
}
