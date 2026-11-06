/**
 * Issue #2860 (15-factor re-audit, Factor 10 Dev/Prod Parity) —
 * DO-SQLite-backed test fixtures for the claims/suppression stores.
 *
 * The re-audit's remaining Factor 10 gap: the G6/G8 tests used the
 * SQL-shaped MockSqlStorage for the claims stores — closer to
 * production than the pure Sets the original audit found, but the
 * doubles are still not DO SQLite. This file runs the SAME stores
 * the production builders wire (createSqlDeliverySuppressionStore,
 * createSqlStageClaimStore) against real SQLite via
 * tests/do-sqlite-fixture.ts — the stores' exact SQL, no mock
 * interpreter in between — including the durability property the
 * claims exist for: a claim survives a close + reopen of the
 * database (the test's stand-in for a DO instance eviction).
 *
 * What this proves that the MockSqlStorage suites cannot:
 *  - the stores' DDL + DML is real-SQLite SQL (CREATE TABLE IF NOT
 *    EXISTS, INSERT OR IGNORE, parameterized SELECT/DELETE);
 *  - the (key) PRIMARY KEY is a real uniqueness constraint, not a
 *    mock Map key — a raw duplicate INSERT throws;
 *  - a claim written by one store instance is visible to a second
 *    store instance over the reopened database (cross-instance
 *    suppression, the Factor 6/9 property the mock cannot show:
 *    a fresh MockSqlStorage is always empty).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createSqlDeliverySuppressionStore } from "../src/data/deliveryClaimsStore";
import { createSqlStageClaimStore } from "../src/data/stageClaimsStore";
import { createDeliverySuppressor } from "../src/workflows/screenDeliverySuppression";
import {
  makeDoSqliteStorage,
  makeDoSqliteFileStorage,
  type DoSqliteFileStorage,
} from "./do-sqlite-fixture";

const files: DoSqliteFileStorage[] = [];
afterEach(() => {
  while (files.length) files.pop()!.remove();
});

describe("delivery suppression store on DO SQLite (#2860 Factor 10)", () => {
  it("claim / already-claimed / release / delete through the real table", () => {
    const { sql, close } = makeDoSqliteStorage();
    try {
      const store = createSqlDeliverySuppressionStore(() => sql);
      const suppressor = createDeliverySuppressor(store);
      expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
      expect(suppressor.tryClaim("run-1", "slack")).toBe(false);
      expect(suppressor.wasClaimed("run-1", "slack")).toBe(true);
      expect(suppressor.wasClaimed("run-1", "email")).toBe(false);
      suppressor.release("run-1", "slack");
      expect(suppressor.wasClaimed("run-1", "slack")).toBe(false);
      expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
      store.delete?.("run-1::slack");
      expect(suppressor.wasClaimed("run-1", "slack")).toBe(false);
    } finally {
      close();
    }
  });

  it("the same run to a different destination is not suppressed", () => {
    const { sql, close } = makeDoSqliteStorage();
    try {
      const suppressor = createDeliverySuppressor(createSqlDeliverySuppressionStore(() => sql));
      expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
      expect(suppressor.tryClaim("run-1", "email:ops@example.com")).toBe(true);
      expect(suppressor.tryClaim("run-2", "slack")).toBe(true);
    } finally {
      close();
    }
  });

  it("a duplicate claim row is a real PRIMARY KEY constraint, not a mock Map key", () => {
    const { sql, close } = makeDoSqliteStorage();
    try {
      const store = createSqlDeliverySuppressionStore(() => sql);
      store.add("run-1::slack");
      // add() itself is INSERT OR IGNORE (a re-add is a no-op, never a
      // throw); the raw duplicate INSERT proves the table carries a
      // real uniqueness constraint underneath.
      expect(() =>
        sql.exec(
          `INSERT INTO mas_delivery_claims (key, claimed_at) VALUES (?, ?)`,
          "run-1::slack",
          new Date().toISOString(),
        ),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      close();
    }
  });

  it("a claim survives close + reopen: a second store instance still suppresses", () => {
    const storage = makeDoSqliteFileStorage();
    files.push(storage);
    const first = createDeliverySuppressor(
      createSqlDeliverySuppressionStore(() => storage.sql),
    );
    expect(first.tryClaim("run-9", "slack")).toBe(true);
    const reopenedSql = storage.reopen();
    const second = createDeliverySuppressor(
      createSqlDeliverySuppressionStore(() => reopenedSql),
    );
    expect(second.tryClaim("run-9", "slack")).toBe(false);
    expect(second.wasClaimed("run-9", "slack")).toBe(true);
    expect(second.tryClaim("run-9", "webhook")).toBe(true);
  });
});

describe("stage claim store on DO SQLite (#2860 Factor 10)", () => {
  it("claim / has / release through the real table", () => {
    const { sql, close } = makeDoSqliteStorage();
    try {
      const claims = createSqlStageClaimStore(() => sql);
      const key = "run-1::generate:pdf";
      expect(claims.has(key)).toBe(false);
      claims.add(key);
      expect(claims.has(key)).toBe(true);
      claims.add(key);
      expect(claims.has(key)).toBe(true);
      claims.delete?.(key);
      expect(claims.has(key)).toBe(false);
    } finally {
      close();
    }
  });

  it("claims are scoped per (run, stage): another run or stage is not claimed", () => {
    const { sql, close } = makeDoSqliteStorage();
    try {
      const claims = createSqlStageClaimStore(() => sql);
      claims.add("run-1::generate:pdf");
      expect(claims.has("run-1::generate:xlsx")).toBe(false);
      expect(claims.has("run-2::generate:pdf")).toBe(false);
    } finally {
      close();
    }
  });

  it("a claim survives close + reopen: a redelivered stage message still suppresses", () => {
    const storage = makeDoSqliteFileStorage();
    files.push(storage);
    const first = createSqlStageClaimStore(() => storage.sql);
    first.add("run-9::generate:pdf");
    expect(first.has("run-9::generate:pdf")).toBe(true);
    const reopenedSql = storage.reopen();
    const second = createSqlStageClaimStore(() => reopenedSql);
    expect(second.has("run-9::generate:pdf")).toBe(true);
    expect(second.has("run-9::generate:xlsx")).toBe(false);
  });
});
