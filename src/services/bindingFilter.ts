/**
 * Issue #5102 (F5 of #5094) — the binding filter for the run-list
 * reads (`GET /api/runs`, `GET /api/workflow-runs`): an optional
 * binding query (broker / mode / account-type / accountId /
 * binding-scope) that narrows the merged list to the rows that
 * executed against that binding. One helper, both routes, so the
 * filter can never drift between surfaces.
 *
 * Validation is the write path's vocabulary: the broker must be a
 * known broker id, the mode live/paper, the account type a known
 * account type, the scope a known binding scope, the account id a
 * real non-empty id (never a poisoned "undefined"/"null" literal,
 * #3650). An invalid value is a 400, never a silent empty page.
 * A valid value that matches nothing returns an empty list — the
 * filter narrows, it never invents rows.
 *
 * Matching is exact per field, and an unbound row never matches a
 * present filter field: a row whose accountId is null is not a row
 * for accountId X, and a row with no recorded broker is not a row
 * for broker Y. Absent filter fields match everything.
 */
import { ACCOUNT_BINDING_SCOPES, ACCOUNT_TYPES } from "../config/accountBindings";
import { isBrokerId } from "../trading";
import { isMissingIdLiteral } from "./consolidatedScheduling";

export interface BindingFilter {
  broker?: string;
  mode?: "live" | "paper";
  accountType?: string;
  accountId?: string;
  bindingScope?: string;
}

export type BindingFilterRow = {
  brokerId?: string | null;
  mode?: string | null;
  accountType?: string | null;
  accountId?: string | null;
  bindingScope?: string | null;
};

export function parseBindingFilter(
  params: URLSearchParams,
): { ok: true; filter: BindingFilter } | { ok: false; error: string } {
  const filter: BindingFilter = {};
  const broker = params.get("broker");
  if (broker !== null && broker !== "") {
    if (!isBrokerId(broker)) {
      return { ok: false, error: `Unknown broker: ${broker}` };
    }
    filter.broker = broker;
  }
  const mode = params.get("mode");
  if (mode !== null && mode !== "") {
    if (mode !== "live" && mode !== "paper") {
      return { ok: false, error: `Unknown mode: ${mode} (expected live or paper)` };
    }
    filter.mode = mode;
  }
  const accountType = params.get("accountType");
  if (accountType !== null && accountType !== "") {
    if (!(ACCOUNT_TYPES as readonly string[]).includes(accountType)) {
      return { ok: false, error: `Unknown account type: ${accountType}` };
    }
    filter.accountType = accountType;
  }
  const accountId = params.get("accountId");
  if (accountId !== null && accountId !== "") {
    if (!accountId.trim() || isMissingIdLiteral(accountId)) {
      return { ok: false, error: "accountId must be a real account id, never a literal undefined/null (#3650)." };
    }
    filter.accountId = accountId;
  }
  const bindingScope = params.get("bindingScope");
  if (bindingScope !== null && bindingScope !== "") {
    if (!(ACCOUNT_BINDING_SCOPES as readonly string[]).includes(bindingScope)) {
      return { ok: false, error: `Unknown binding scope: ${bindingScope}` };
    }
    filter.bindingScope = bindingScope;
  }
  return { ok: true, filter };
}

/** True when the filter carries no field at all (matches everything). */
export function isEmptyBindingFilter(filter: BindingFilter): boolean {
  return Object.keys(filter).length === 0;
}

export function matchesBindingFilter(row: BindingFilterRow, filter: BindingFilter): boolean {
  if (filter.broker !== undefined && row.brokerId !== filter.broker) return false;
  if (filter.mode !== undefined && row.mode !== filter.mode) return false;
  if (filter.accountType !== undefined && row.accountType !== filter.accountType) return false;
  if (filter.accountId !== undefined && row.accountId !== filter.accountId) return false;
  if (filter.bindingScope !== undefined && row.bindingScope !== filter.bindingScope) return false;
  return true;
}
