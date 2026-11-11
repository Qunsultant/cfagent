// @vitest-environment node
/**
 * Issue #2155 follow-up — journal recognition schedule
 * (deferred revenue 2100 → revenue 4000 over a subscription
 * period). The schedule itself was deliberately not built in
 * the #2155 journal slice or in the #2364 deferred-revenue
 * slice (no sweeper, no cron, no amortization logic there);
 * this slice builds exactly the schedule plus the posting
 * function a future caller (route or sweeper) would call.
 * Nothing here runs autonomously: no route, no cron, no
 * wiring into any payment path is added by this slice.
 *
 * Rules pinned here:
 *  - Straight-line daily recognition in integer cents, so the
 *    installments sum EXACTLY to the deferred amount.
 *  - One balanced pair per due installment: Dr 2100 / Cr 4000,
 *    family "subscription", runRequestId = subscription id,
 *    transactionRef `${purchaseRef}:recognition:${n}` — so a
 *    replay is a no-op via the port's idempotency.
 *  - Tenant-scoped always: the schedule derives from the
 *    tenant's own journal entries + that tenant's subscription
 *    row; a cross-tenant entry throws, never posts.
 *  - The DO ledger stays authoritative; recognition posting is
 *    best-effort through the journal port and never throws
 *    into a payment path (best-effort wrapper resolves).
 *  - Per-tenant trial balance stays balanced after recognition
 *    posts (total debits == total credits).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRecognitionSchedule,
  deriveDeferredAmount,
  dueInstallments,
  mapRecognitionToJournalEntries,
  postDueRecognition,
  postDueRecognitionBestEffort,
  recognitionAsOf,
  recognizedAmountFromEntries,
  scheduleForSubscription,
  MS_PER_DAY,
  type RecognitionScheduleInput,
} from "../src/services/journalRecognition";
import { InMemoryJournalAdapter } from "../src/data/inMemoryJournalAdapter";
import {
  mapSubscriptionPurchaseToJournalEntries,
  trialBalance,
} from "../src/data/journalPorts";

const DAY = MS_PER_DAY;
const START = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z

function input(over: Partial<RecognitionScheduleInput> = {}): RecognitionScheduleInput {
  return {
    tenantId: "tenant-a",
    subscriptionId: "sub-1",
    deferredAmountUSD: 30,
    periodStartMs: START,
    periodEndMs: START + 30 * DAY,
    purchaseTransactionRef: "sub-checkout-1",
    ...over,
  };
}

describe("recognition schedule — pure computation (#2155 follow-up)", () => {
  it("recognizes straight-line daily over the period, summing exactly to the deferred amount", () => {
    const s = buildRecognitionSchedule(input());
    expect(s.days).toBe(30);
    expect(s.installments).toHaveLength(30);
    expect(s.totalScheduledUSD).toBe(30);
    expect(s.installments.every((i) => i.amountUSD === 1)).toBe(true);
    expect(s.installments[0].dueMs).toBe(START + DAY);
    expect(s.installments[29].dueMs).toBe(START + 30 * DAY);
    expect(s.installments[0].transactionRef).toBe("sub-checkout-1:recognition:1");
    expect(s.installments[29].transactionRef).toBe("sub-checkout-1:recognition:30");
  });

  it("distributes a cent remainder across early installments so the sum stays exact", () => {
    const s = buildRecognitionSchedule(
      input({ deferredAmountUSD: 10, periodEndMs: START + 3 * DAY }),
    );
    expect(s.installments.map((i) => i.amountUSD)).toEqual([3.34, 3.33, 3.33]);
    expect(s.totalScheduledUSD).toBe(10);
  });

  it("falls back to the subscription id as the installment ref base when no purchase ref is known", () => {
    const s = buildRecognitionSchedule(input({ purchaseTransactionRef: undefined }));
    expect(s.installments[0].transactionRef).toBe("sub-1:recognition:1");
  });

  it("fails closed on a blank tenant, blank subscription, bad period, or non-positive amount", () => {
    expect(() => buildRecognitionSchedule(input({ tenantId: "" }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ subscriptionId: "  " }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ periodEndMs: START }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ periodEndMs: START - DAY }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ deferredAmountUSD: 0 }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ deferredAmountUSD: -5 }))).toThrow();
    expect(() => buildRecognitionSchedule(input({ deferredAmountUSD: Number.NaN }))).toThrow();
  });

  it("due-as-of: nothing before the period, a prefix mid-period, everything at period end", () => {
    const s = buildRecognitionSchedule(input());
    expect(dueInstallments(s, START)).toHaveLength(0);
    expect(recognitionAsOf(s, START + 10 * DAY).recognizedUSD).toBe(10);
    expect(recognitionAsOf(s, START + 10 * DAY).remainingUSD).toBe(20);
    expect(dueInstallments(s, START + 30 * DAY)).toHaveLength(30);
    expect(recognitionAsOf(s, START + 31 * DAY).recognizedUSD).toBe(30);
    expect(recognitionAsOf(s, START + 31 * DAY).remainingUSD).toBe(0);
  });
});

describe("recognition mapping (#2155 follow-up)", () => {
  it("maps one installment to Dr 2100 / Cr 4000, subscription family, subscription id as runRequestId", () => {
    const s = buildRecognitionSchedule(input());
    const entries = mapRecognitionToJournalEntries({
      tenantId: "tenant-a",
      subscriptionId: "sub-1",
      installment: s.installments[0],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      transactionRef: "sub-checkout-1:recognition:1",
      accountCode: "2100",
      debitUSD: 1,
      creditUSD: 0,
      tenantId: "tenant-a",
      runRequestId: "sub-1",
      family: "subscription",
    });
    expect(entries[1]).toMatchObject({
      accountCode: "4000",
      debitUSD: 0,
      creditUSD: 1,
    });
  });

  it("refuses a zero-amount installment (a zero pair would fail the port's one-nonzero-side rule)", () => {
    const s = buildRecognitionSchedule(input());
    expect(() =>
      mapRecognitionToJournalEntries({
        tenantId: "tenant-a",
        subscriptionId: "sub-1",
        installment: { ...s.installments[0], amountUSD: 0 },
      }),
    ).toThrow();
  });
});

describe("recognition derivation from journal entries + subscription period", () => {
  function purchaseEntries() {
    return mapSubscriptionPurchaseToJournalEntries({
      transactionRef: "sub-checkout-1",
      tenantId: "tenant-a",
      subscriptionId: "sub-1",
      productId: "prod-sub-basic",

      versionId: "plan-basic-v1",
      amountUSD: 30,
    });
  }

  it("derives the deferred amount and purchase ref from the 2100 credit, and null when nothing deferred", () => {
    const derived = deriveDeferredAmount(purchaseEntries(), {
      tenantId: "tenant-a",
      id: "sub-1",
    });
    expect(derived).toEqual({ deferredAmountUSD: 30, purchaseTransactionRef: "sub-checkout-1" });
    expect(deriveDeferredAmount([], { tenantId: "tenant-a", id: "sub-1" })).toBeNull();
  });

  it("ignores non-subscription and non-2100 entries, and throws on a cross-tenant entry for the same subscription", () => {
    const crossTenant = purchaseEntries().map((e) => ({ ...e, tenantId: "tenant-b" }));
    expect(() =>
      deriveDeferredAmount(crossTenant, { tenantId: "tenant-a", id: "sub-1" }),
    ).toThrow(/tenant/i);
    const otherSubscription = purchaseEntries().map((e) => ({ ...e, runRequestId: "sub-2" }));
    expect(deriveDeferredAmount(otherSubscription, { tenantId: "tenant-a", id: "sub-1" })).toBeNull();
  });

  it("counts only posted recognition pairs as recognized", () => {
    const s = buildRecognitionSchedule(input());
    const posted = [
      ...mapRecognitionToJournalEntries({ tenantId: "tenant-a", subscriptionId: "sub-1", installment: s.installments[0] }),
      ...mapRecognitionToJournalEntries({ tenantId: "tenant-a", subscriptionId: "sub-1", installment: s.installments[1] }),
    ];
    expect(
      recognizedAmountFromEntries(posted, { tenantId: "tenant-a", id: "sub-1" }, "sub-checkout-1"),
    ).toBe(2);
    expect(
      recognizedAmountFromEntries(purchaseEntries(), { tenantId: "tenant-a", id: "sub-1" }, "sub-checkout-1"),
    ).toBe(0);
  });
});

describe("recognition posting through the journal port (#2155 follow-up)", () => {
  async function postedSetup() {
    const port = new InMemoryJournalAdapter();
    await port.postEntries(
      mapSubscriptionPurchaseToJournalEntries({
        transactionRef: "sub-checkout-1",
        tenantId: "tenant-a",
        subscriptionId: "sub-1",
        productId: "prod-sub-basic",
        versionId: "plan-basic-v1",
        amountUSD: 30,
      }),
    );
    return port;
  }

  const subscription = {
    tenantId: "tenant-a",
    id: "sub-1",
    periodStartMs: START,
    periodEndMs: START + 30 * DAY,
  };

  it("posts only due installments, keeps the per-tenant trial balance balanced, and replays as a no-op", async () => {
    const port = await postedSetup();
    const first = await postDueRecognition(port, subscription, START + 10 * DAY);
    expect(first.schedule?.totalScheduledUSD).toBe(30);
    expect(first.posted).toHaveLength(20); // 10 installments × 2 entries (flattened)
    expect(first.alreadyPosted).toHaveLength(0);
    expect(first.unpostedDueUSD).toBe(0);

    const tb = await trialBalance(port, "tenant-a");
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebits).toBe(40); // 30 purchase funds + 10 recognized out of deferred
    expect(tb.totalCredits).toBe(40);
    const deferred = tb.accounts.find((a) => a.code === "2100")!;
    const revenue = tb.accounts.find((a) => a.code === "4000")!;
    expect(deferred.creditTotal - deferred.debitTotal).toBe(20); // 30 deferred, 10 recognized
    expect(revenue.creditTotal).toBe(10);

    const second = await postDueRecognition(port, subscription, START + 10 * DAY);
    expect(second.posted).toHaveLength(0);
    expect(second.alreadyPosted).toHaveLength(10);
    expect((await port.listEntries("tenant-a")).length).toBe(2 + 20); // purchase pair + 10 recognition pairs

    const rest = await postDueRecognition(port, subscription, START + 30 * DAY);
    expect(rest.posted).toHaveLength(40); // 20 installments × 2 entries (flattened)
    const finalTb = await trialBalance(port, "tenant-a");
    expect(finalTb.balanced).toBe(true);
    expect(finalTb.accounts.find((a) => a.code === "2100")!.creditTotal).toBe(
      finalTb.accounts.find((a) => a.code === "2100")!.debitTotal,
    );
  });

  it("scheduleForSubscription returns null when nothing is deferred, and never sees another tenant's entries", async () => {
    const port = new InMemoryJournalAdapter();
    expect(await scheduleForSubscription(port, subscription, START + 10 * DAY)).toBeNull();
    const other = new InMemoryJournalAdapter();
    await other.postEntries(
      mapSubscriptionPurchaseToJournalEntries({
        transactionRef: "sub-checkout-9",
        tenantId: "tenant-b",
        subscriptionId: "sub-1",
        productId: "prod-sub-basic",
        versionId: "plan-basic-v1",
        amountUSD: 99,
      }),
    );
    // Same subscription id under another tenant must not leak into tenant-a's schedule.
    expect(await scheduleForSubscription(port, subscription, START + 10 * DAY)).toBeNull();
  });

  it("best-effort wrapper never throws: null port, throwing setup, and throwing port all resolve", async () => {
    await expect(
      postDueRecognitionBestEffort(async () => null, subscription, START + 10 * DAY),
    ).resolves.toBeUndefined();
    await expect(
      postDueRecognitionBestEffort(async () => {
        throw new Error("D1 unavailable");
      }, subscription, START + 10 * DAY),
    ).resolves.toBeUndefined();
    const throwingPort = {
      postEntries: async () => {
        throw new Error("D1 unavailable");
      },
      listEntries: async () => {
        throw new Error("D1 unavailable");
      },
      getEntriesByRef: async () => [],
      listAccounts: async () => [],
    };
    await expect(
      postDueRecognitionBestEffort(async () => throwingPort as never, subscription, START + 10 * DAY),
    ).resolves.toBeUndefined();
  });
});

describe("recognition module structural pin (#2155 follow-up)", () => {
  it("imports no store client, adapter, or env binding (port-first, ADR 0002)", () => {
    const imports = readFileSync(resolve(__dirname, "../src/services/journalRecognition.ts"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
    const joined = imports.join("\n");
    expect(joined).not.toContain("drizzle-orm");
    expect(joined).not.toContain("D1Database");
    expect(joined).not.toContain("d1JournalAdapter");
    expect(joined).not.toContain("inMemoryJournalAdapter");
    expect(joined).not.toContain("AGENT_DB");
  });
});
