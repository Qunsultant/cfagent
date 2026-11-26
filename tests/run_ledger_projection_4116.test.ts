/**
 * @deprecated Retired by #6101 (2026-11-26) — the #4116 projector suite: migration, conditional upsert, carrier config, twin links, the shared projector, the queue/ORM/sweep carriers, and the #6103 D1-read describes.
 * Superseded by src/data/createJobRunRecordPorts.ts (recordLedgerRunD1 — the D1 writer is the only ledger write). The describes below are skipped
 * placeholders: the test titles are preserved so no test disappears,
 * but no dead-world assertion is resurrected — the world this suite
 * pinned no longer exists. (Tests are excluded from gate (j); the
 * note is carried anyway so the file states its own retirement.)
 */
import { describe, it } from "vitest";

describe.skip("migration 0059 (run ledger, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("async-job conditional upsert (shared ordering rule, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("carrier config (configurable + externalized, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("twin-link resolution (projection-time, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("shared projector (one writer, three carriers, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("job-run-records projection (DO→D1, #6099)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("best-effort post (ORM carrier, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("queue carrier (run-ledger.project, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("write-site hooks (ORM + queue carriers, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("sweep carrier (one-off backfill, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("queue consumer DO door (projectQueuedRunLedger, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("owner scope + backfill (migration 0060, #4116)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("D1-only reads (#6103)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("D1 outcomes list read (#6103 Q1)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("unconfigured tenant is named in storeErrors (#6103 Q4)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});
