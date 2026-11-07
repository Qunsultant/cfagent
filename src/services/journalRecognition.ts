/**
 * Issue #2155 follow-up — journal recognition schedule
 * (deferred revenue 2100 → revenue 4000 over a subscription
 * period).
 *
 * The #2155 journal slice and the #2364 deferred-revenue
 * slice both deliberately left this unbuilt: a subscription
 * purchase posts Dr 1000 / Cr 2100 and the amount sits in
 * deferred revenue until this schedule moves it to earned
 * revenue. This module builds the schedule and the posting
 * function a caller would use — and nothing more:
 *
 *  - NO autonomous sweeper, NO cron, NO background job.
 *  - NO HTTP route and NO wiring into any payment path:
 *    nothing in this module runs on its own, so no money
 *    moves until a future slice wires postDueRecognition
 *    (or postDueRecognitionBestEffort) to an explicit
 *    caller. That wiring is a separate follow-up, not
 *    smuggled in here.
 *  - NO real-GL adapter work: the journal port shape is
 *    unchanged; recognition posts through JournalPort, so a
 *    future GL adapter swaps in behind the same port.
 *
 * Authority and safety (same as the journal itself):
 *  - The DO ledger stays authoritative; the journal is a
 *    best-effort D1 projection. The throwing posting
 *    function is for explicit callers; the best-effort
 *    wrapper loud-logs and NEVER throws into a payment
 *    path.
 *  - Session-scoped ALWAYS: every function takes the
 *    tenant from the subscription row (which itself
 *    derives from the verified session at purchase time),
 *    never from a client-supplied tenantId. Journal
 *    entries never cross tenants: a cross-tenant entry
 *    for the same subscription id throws.
 *  - Port-first (ADR 0002): this module imports port
 *    types and the pure round2 helper from
 *    src/data/journalPorts.ts ONLY — no store client, no
 *    drizzle-orm, no env binding, no SQL.
 *
 * Schedule semantics (straight-line, daily, in cents):
 *  - One installment per whole day of the subscription
 *    period (periods are whole days; see
 *    subscriptionPorts.MS_PER_DAY). Installment i is due
 *    at the end of day i (periodStart + (i+1) days), the
 *    last one at periodEnd exactly, so no installment is
 *    ever due after the period ends.
 *  - Amounts are computed in integer cents: the total is
 *    split into equal cents with the remainder cents on
 *    the earliest installments, so the installments sum
 *    EXACTLY to the deferred amount (no rounding drift,
 *    no remainder-on-last-day surprise).
 *  - A zero-amount installment (possible only when the
 *    deferred total in cents is smaller than the day
 *    count) stays in the schedule for completeness but is
 *    never posted: a zero pair would fail the port's
 *    exactly-one-nonzero-side rule.
 *
 * Posting semantics:
 *  - One balanced pair per installment: Dr 2100 / Cr 4000,
 *    family "subscription", runRequestId = subscription
 *    id (the same reference convention the purchase
 *    mapping uses), transactionRef
 *    `${purchaseRef}:recognition:${n}` (1-based) — or
 *    `${subscriptionId}:recognition:${n}` when the
 *    purchase ref is unknown. The port's replay rule
 *    makes re-posting an installment a no-op, and
 *    postDueRecognition additionally pre-checks each ref
 *    so a second run reports already-posted instead of
 *    re-posting.
 *  - The deferred total is derived from the tenant's own
 *    2100 credits for that subscription (the purchase
 *    post), never from a client-supplied amount: a caller
 *    cannot schedule recognition for money that was
 *    never deferred.
 */

import {
  round2,
  type JournalEntry,
  type JournalEntryInput,
  type JournalPort,
} from "../data/journalPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/journalRecognition",
});

/** One day in epoch-ms; subscription periods are whole days. */
export const MS_PER_DAY = 86_400_000;

export const JOURNAL_DEFERRED_ACCOUNT = "2100";
export const JOURNAL_REVENUE_ACCOUNT = "4000";

export interface RecognitionScheduleInput {
  tenantId: string;
  subscriptionId: string;
  deferredAmountUSD: number;
  currency?: string;
  periodStartMs: number;
  periodEndMs: number;
  /** The purchase transactionRef (checkoutRequestId) when known; else the subscription id is the ref base. */
  purchaseTransactionRef?: string;
}

export interface RecognitionInstallment {
  /** 0-based position in the schedule. */
  index: number;
  /** 1-based installment number, used in the transactionRef. */
  installmentNumber: number;
  dueMs: number;
  amountUSD: number;
  transactionRef: string;
  fromAccountCode: string;
  toAccountCode: string;
}

export interface RecognitionSchedule {
  tenantId: string;
  subscriptionId: string;
  deferredAmountUSD: number;
  currency: string;
  periodStartMs: number;
  periodEndMs: number;
  days: number;
  installments: RecognitionInstallment[];
  totalScheduledUSD: number;
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Recognition schedule requires a non-blank ${field}.`);
  }
  return value;
}

/**
 * PURE: build the straight-line daily schedule for one
 * subscription's deferred amount. Throws (fail closed) on a
 * blank tenant/subscription, a non-positive or non-finite
 * amount, or a period that does not end after it starts.
 */
export function buildRecognitionSchedule(input: RecognitionScheduleInput): RecognitionSchedule {
  const tenantId = requireNonBlank(input.tenantId, "tenantId");
  const subscriptionId = requireNonBlank(input.subscriptionId, "subscriptionId");
  const deferredAmountUSD = round2(input.deferredAmountUSD);
  if (!Number.isFinite(deferredAmountUSD) || deferredAmountUSD <= 0) {
    throw new Error("Recognition schedule requires a positive finite deferredAmountUSD.");
  }
  if (!Number.isFinite(input.periodStartMs) || !Number.isFinite(input.periodEndMs)) {
    throw new Error("Recognition schedule requires finite periodStartMs and periodEndMs.");
  }
  if (input.periodEndMs <= input.periodStartMs) {
    throw new Error("Recognition schedule requires periodEndMs after periodStartMs.");
  }
  const days = Math.max(1, Math.round((input.periodEndMs - input.periodStartMs) / MS_PER_DAY));
  const totalCents = Math.round(deferredAmountUSD * 100);
  const baseCents = Math.floor(totalCents / days);
  const remainderCents = totalCents - baseCents * days;
  const refBase =
    typeof input.purchaseTransactionRef === "string" && input.purchaseTransactionRef.trim()
      ? input.purchaseTransactionRef
      : subscriptionId;
  const installments: RecognitionInstallment[] = [];
  for (let i = 0; i < days; i++) {
    const amountCents = baseCents + (i < remainderCents ? 1 : 0);
    installments.push({
      index: i,
      installmentNumber: i + 1,
      dueMs: i < days - 1 ? input.periodStartMs + (i + 1) * MS_PER_DAY : input.periodEndMs,
      amountUSD: amountCents / 100,
      transactionRef: `${refBase}:recognition:${i + 1}`,
      fromAccountCode: JOURNAL_DEFERRED_ACCOUNT,
      toAccountCode: JOURNAL_REVENUE_ACCOUNT,
    });
  }
  const totalScheduledUSD = round2(
    installments.reduce((sum, inst) => sum + inst.amountUSD, 0),
  );
  return {
    tenantId,
    subscriptionId,
    deferredAmountUSD,
    currency: input.currency ?? "USD",
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    days,
    installments,
    totalScheduledUSD,
  };
}

/** PURE: installments whose due time has arrived by asOfMs. */
export function dueInstallments(
  schedule: RecognitionSchedule,
  asOfMs: number,
): RecognitionInstallment[] {
  return schedule.installments.filter((inst) => inst.dueMs <= asOfMs);
}

/** PURE: how much of the schedule is due by asOfMs, and how much remains. */
export function recognitionAsOf(
  schedule: RecognitionSchedule,
  asOfMs: number,
): { recognizedUSD: number; remainingUSD: number } {
  const recognizedUSD = round2(
    dueInstallments(schedule, asOfMs).reduce((sum, inst) => sum + inst.amountUSD, 0),
  );
  return { recognizedUSD, remainingUSD: round2(schedule.totalScheduledUSD - recognizedUSD) };
}

export interface RecognitionMappingInput {
  tenantId: string;
  subscriptionId: string;
  installment: RecognitionInstallment;
  currency?: string;
}

/**
 * PURE mapping: one installment → Dr 2100 / Cr 4000.
 * Throws on a zero or negative installment amount (a zero
 * pair cannot pass the port's one-nonzero-side rule, so
 * callers skip zero installments instead of mapping them).
 */
export function mapRecognitionToJournalEntries(
  input: RecognitionMappingInput,
): JournalEntryInput[] {
  const tenantId = requireNonBlank(input.tenantId, "tenantId");
  const subscriptionId = requireNonBlank(input.subscriptionId, "subscriptionId");
  const transactionRef = requireNonBlank(input.installment.transactionRef, "transactionRef");
  const amount = round2(input.installment.amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Recognition mapping requires a positive finite installment amountUSD.");
  }
  const currency = input.currency ?? "USD";
  return [
    {
      transactionRef,
      accountCode: JOURNAL_DEFERRED_ACCOUNT,
      debitUSD: amount,
      creditUSD: 0,
      currency,
      tenantId,
      runRequestId: subscriptionId,
      family: "subscription",
    },
    {
      transactionRef,
      accountCode: JOURNAL_REVENUE_ACCOUNT,
      debitUSD: 0,
      creditUSD: amount,
      currency,
      tenantId,
      runRequestId: subscriptionId,
      family: "subscription",
    },
  ];
}

export interface SubscriptionIdentity {
  tenantId: string;
  id: string;
  periodStartMs: number;
  periodEndMs: number;
}

/**
 * PURE derivation: the deferred total for one subscription
 * from journal entries (tenant-scoped by the caller: pass
 * only entries read through the port for this tenant).
 * Sums the 2100 credits stamped with this subscription id
 * and family "subscription" — i.e. the purchase post(s).
 * Returns null when nothing was ever deferred for this
 * subscription. Throws if any entry for this subscription
 * id carries a different tenant (cross-tenant, fail closed).
 */
export function deriveDeferredAmount(
  entries: JournalEntry[],
  subscription: { tenantId: string; id: string },
): { deferredAmountUSD: number; purchaseTransactionRef: string } | null {
  const tenantId = requireNonBlank(subscription.tenantId, "tenantId");
  const subscriptionId = requireNonBlank(subscription.id, "subscriptionId");
  const deferred = entries.filter(
    (e) =>
      e.runRequestId === subscriptionId &&
      e.family === "subscription" &&
      e.accountCode === JOURNAL_DEFERRED_ACCOUNT,
  );
  for (const e of deferred) {
    if (e.tenantId !== tenantId) {
      throw new Error(
        `Journal recognition for subscription ${subscriptionId} found an entry under another tenant; refusing cross-tenant recognition.`,
      );
    }
  }
  const credits = deferred.filter((e) => e.creditUSD > 0);
  if (credits.length === 0) return null;
  const ordered = [...credits].sort((a, b) =>
    a.createdAtMs !== b.createdAtMs
      ? a.createdAtMs - b.createdAtMs
      : a.transactionRef < b.transactionRef
        ? -1
        : 1,
  );
  return {
    deferredAmountUSD: round2(credits.reduce((sum, e) => sum + e.creditUSD, 0)),
    purchaseTransactionRef: ordered[0].transactionRef,
  };
}

/**
 * PURE: how much has actually been posted as recognition
 * for one subscription — the 4000 credits stamped with a
 * recognition transactionRef for this subscription. The
 * purchase post (a 2100 credit, no 4000 credit) never
 * counts; neither do charge/redemption 4000 credits, which
 * carry a run id and family, not this subscription id and
 * recognition ref. Throws on a cross-tenant match, as
 * deriveDeferredAmount does.
 */
export function recognizedAmountFromEntries(
  entries: JournalEntry[],
  subscription: { tenantId: string; id: string },
  purchaseTransactionRef: string,
): number {
  const tenantId = requireNonBlank(subscription.tenantId, "tenantId");
  const subscriptionId = requireNonBlank(subscription.id, "subscriptionId");
  const prefixes = [
    `${purchaseTransactionRef}:recognition:`,
    `${subscriptionId}:recognition:`,
  ];
  const recognized = entries.filter(
    (e) =>
      e.runRequestId === subscriptionId &&
      e.family === "subscription" &&
      e.accountCode === JOURNAL_REVENUE_ACCOUNT &&
      prefixes.some((p) => e.transactionRef.startsWith(p)),
  );
  for (const e of recognized) {
    if (e.tenantId !== tenantId) {
      throw new Error(
        `Journal recognition for subscription ${subscriptionId} found a recognition entry under another tenant; refusing cross-tenant recognition.`,
      );
    }
  }
  return round2(recognized.reduce((sum, e) => sum + e.creditUSD, 0));
}

export interface RecognitionScheduleReport {
  schedule: RecognitionSchedule;
  /** Actually posted as recognition so far (4000 credits), from the journal — not merely due. */
  recognizedPostedUSD: number;
  /** Schedule amount due by asOfMs, whether posted or not. */
  dueAsOfUSD: number;
  /** Due but not yet posted (never negative: over-posting is a reconcile signal, not a negative due). */
  unpostedDueUSD: number;
}

/**
 * Build the schedule for one subscription from the tenant's
 * own journal entries (port read, tenant-scoped) plus the
 * subscription period. Returns null when nothing was ever
 * deferred for this subscription — there is no schedule
 * for money that was never deferred.
 */
export async function scheduleForSubscription(
  port: JournalPort,
  subscription: SubscriptionIdentity,
  asOfMs: number,
): Promise<RecognitionScheduleReport | null> {
  const tenantId = requireNonBlank(subscription.tenantId, "tenantId");
  const entries = await port.listEntries(tenantId);
  const derived = deriveDeferredAmount(entries, subscription);
  if (!derived) return null;
  const schedule = buildRecognitionSchedule({
    tenantId,
    subscriptionId: subscription.id,
    deferredAmountUSD: derived.deferredAmountUSD,
    periodStartMs: subscription.periodStartMs,
    periodEndMs: subscription.periodEndMs,
    purchaseTransactionRef: derived.purchaseTransactionRef,
  });
  const recognizedPostedUSD = recognizedAmountFromEntries(
    entries,
    subscription,
    derived.purchaseTransactionRef,
  );
  const dueAsOfUSD = recognitionAsOf(schedule, asOfMs).recognizedUSD;
  return {
    schedule,
    recognizedPostedUSD,
    dueAsOfUSD,
    unpostedDueUSD: Math.max(0, round2(dueAsOfUSD - recognizedPostedUSD)),
  };
}

export interface DueRecognitionResult {
  schedule: RecognitionSchedule | null;
  /** Entries written by this call (flattened across installments). */
  posted: JournalEntry[];
  /** Due installment refs already present in the journal (replay, not re-posted). */
  alreadyPosted: string[];
  /** Due-but-unposted amount remaining after this call (0 when every due installment posted). */
  unpostedDueUSD: number;
}

/**
 * Post every due installment for one subscription through
 * the journal port. Idempotent: an installment whose ref
 * already exists in this tenant is reported as
 * already-posted, never re-posted (and the port's own
 * replay rule covers the race where another caller posts
 * between the check and the post). Zero-amount
 * installments are skipped, never mapped. Throws on
 * validation / tenant-mismatch failures — callers that
 * must never fail use postDueRecognitionBestEffort.
 */
export async function postDueRecognition(
  port: JournalPort,
  subscription: SubscriptionIdentity,
  asOfMs: number,
): Promise<DueRecognitionResult> {
  const report = await scheduleForSubscription(port, subscription, asOfMs);
  if (!report) {
    return { schedule: null, posted: [], alreadyPosted: [], unpostedDueUSD: 0 };
  }
  const { schedule } = report;
  const posted: JournalEntry[] = [];
  const alreadyPosted: string[] = [];
  for (const installment of dueInstallments(schedule, asOfMs)) {
    if (installment.amountUSD <= 0) continue;
    const existing = await port.getEntriesByRef(installment.transactionRef, schedule.tenantId);
    if (existing.length > 0) {
      alreadyPosted.push(installment.transactionRef);
      continue;
    }
    const written = await port.postEntries(
      mapRecognitionToJournalEntries({
        tenantId: schedule.tenantId,
        subscriptionId: schedule.subscriptionId,
        installment,
        currency: schedule.currency,
      }),
    );
    posted.push(...written);
  }
  const postedUSD = round2(posted.reduce((sum, e) => sum + e.creditUSD, 0));
  return {
    schedule,
    posted,
    alreadyPosted,
    unpostedDueUSD: Math.max(
      0,
      round2(report.dueAsOfUSD - report.recognizedPostedUSD - postedUSD),
    ),
  };
}

/**
 * Best-effort wrapper: the journal is a projection, never
 * the authority, so a recognition failure is loud-logged
 * and NEVER thrown into a caller — including any payment
 * path a future caller wires this into. A null port
 * (AGENT_DB unbound) is a skip, not an error.
 */
export async function postDueRecognitionBestEffort(
  setup: () => Promise<JournalPort | null>,
  subscription: SubscriptionIdentity,
  asOfMs: number,
): Promise<void> {
  try {
    const port = await setup();
    if (!port) {
      structuredLog.error("journal.recognition_post_skipped", {
        message: "[journal] recognition post skipped (AGENT_DB unbound); payment/ledger unaffected.",
      });
      return;
    }
    await postDueRecognition(port, subscription, asOfMs);
  } catch (err) {
    structuredLog.error("journal.recognition_post_failed", {
      message: "[journal] recognition post failed — payment/ledger unaffected",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
