// @vitest-environment node
/**
 * Issue #6503 — the heartbeat tick's due-checks (issue #4234, ADR
 * 0030) are RETIRED: token-renewal and retention are real stored
 * platform-level schedules now, fired through their entry points
 * when the stored schedule fires — never from the alarm tick.
 *
 * What this file pins now is what remains of that seam: the
 * identity constants the list readers, the entry points, and the
 * stored records all join on. A cron run's ledger jobId IS its
 * cron expression (S1 §4); the record id is the stored schedule's
 * id. If either value moves, the last-run joins and the ledger
 * linkage break with it.
 */
import { describe, it, expect } from "vitest";

import {
  RENEWAL_DISPATCH_CRON,
  RETENTION_DISPATCH_CRON,
  RETENTION_RECORD_ID,
  TOKEN_RENEWAL_RECORD_ID,
} from "../src/services/heartbeatDueChecks";

describe("renewal / retention identity seam (#6503)", () => {
  it("names the dispatch crons as the ledger jobIds (S1: a cron run's jobId IS its cron expression)", () => {
    expect(RENEWAL_DISPATCH_CRON).toBe("0 3 * * *");
    expect(RETENTION_DISPATCH_CRON).toBe("0 4 * * *");
  });

  it("names the stored record ids beside their ledger jobIds", () => {
    expect(TOKEN_RENEWAL_RECORD_ID).toBe("token-renewal");
    expect(RETENTION_RECORD_ID).toBe("retention");
  });

  it("keeps record ids distinct from ledger jobIds", () => {
    expect(TOKEN_RENEWAL_RECORD_ID).not.toBe(RENEWAL_DISPATCH_CRON);
    expect(RETENTION_RECORD_ID).not.toBe(RETENTION_DISPATCH_CRON);
    expect(TOKEN_RENEWAL_RECORD_ID).not.toBe(RETENTION_RECORD_ID);
  });
});
