/**
 * Issue #2842 — composition root for the user-request-quota
 * port family. The screener imports these helpers and the port
 * type, never a store client. Construction executes nothing;
 * the tables' DDL runs only through the port's ensureSchema.
 */
import { DoSqliteUserRequestQuota } from "./doSqliteUserRequestQuotaAdapter";
import { InMemoryUserRequestQuota } from "./inMemoryUserRequestQuotaAdapter";
import type {
  UserRequestQuotaPort,
  UserRequestQuotaSqlExecutor,
} from "./userRequestQuotaPorts";

/** Compose the quota port over a host's DO storage. */
export function createUserRequestQuotaPort(
  sql: UserRequestQuotaSqlExecutor,
): UserRequestQuotaPort {
  return new DoSqliteUserRequestQuota(sql);
}

/** Test double: the in-memory port (no storage handle needed). */
export function createInMemoryUserRequestQuotaPort(): UserRequestQuotaPort {
  return new InMemoryUserRequestQuota();
}
