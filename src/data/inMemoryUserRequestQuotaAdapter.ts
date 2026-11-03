/**
 * Issue #2842 — in-memory implementation of the user-request-
 * quota port. Test double only: production composes the DO
 * SQLite adapter. Behavior mirrors it exactly (same keying,
 * same idempotency, same counts) so gate tests run against
 * either adapter interchangeably.
 */
import type {
  UserRequestQuotaChargeInput,
  UserRequestQuotaOverride,
  UserRequestQuotaOverrideInput,
  UserRequestQuotaPort,
  UserRequestQuotaProbe,
  UserRequestQuotaProbeInput,
} from "./userRequestQuotaPorts";

interface ChargeRow {
  kind: string;
  runId: string;
  chargedAt: number;
}

export class InMemoryUserRequestQuota implements UserRequestQuotaPort {
  private readonly charges = new Map<string, ChargeRow[]>();
  private readonly overrides: UserRequestQuotaOverride[] = [];

  ensureSchema(): void {
    // No schema for a Map; present so the gate calls one seam.
  }

  private windowKey(input: {
    tenantId: string;
    userLogin: string;
    windowKind: string;
    windowKey: string;
  }): string {
    return [input.tenantId, input.userLogin, input.windowKind, input.windowKey].join("\0");
  }

  probe(input: UserRequestQuotaProbeInput): UserRequestQuotaProbe {
    const rows = this.charges.get(this.windowKey(input)) ?? [];
    return {
      usage: rows.length,
      overrides: this.overrides
        .filter(
          (o) =>
            o.tenantId === input.tenantId &&
            o.userLogin === input.userLogin &&
            o.windowKind === input.windowKind &&
            o.windowKey === input.windowKey,
        )
        .sort((a, b) => b.createdMs - a.createdMs),
      alreadyCounted:
        input.runId !== undefined && rows.some((r) => r.runId === input.runId),
    };
  }

  chargeWindow(input: UserRequestQuotaChargeInput): { usage: number } {
    const key = this.windowKey(input);
    const rows = this.charges.get(key) ?? [];
    if (!rows.some((r) => r.runId === input.runId)) {
      rows.push({ kind: input.kind, runId: input.runId, chargedAt: input.nowMs });
      this.charges.set(key, rows);
    }
    return { usage: rows.length };
  }

  grantOverride(input: UserRequestQuotaOverrideInput): UserRequestQuotaOverride {
    const row: UserRequestQuotaOverride = { id: crypto.randomUUID(), ...input };
    this.overrides.push(row);
    return row;
  }

  listOverrides(input: { tenantId: string; userLogin: string }): UserRequestQuotaOverride[] {
    return this.overrides
      .filter((o) => o.tenantId === input.tenantId && o.userLogin === input.userLogin)
      .sort((a, b) => b.createdMs - a.createdMs);
  }
}
