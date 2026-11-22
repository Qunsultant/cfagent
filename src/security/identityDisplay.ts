/**
 * #6164 (parent #945) — one identity join for every IAAA admin surface.
 *
 * CONSISTENT INFORMATION EVERYWHERE: every surface shows the same entity the
 * same way (login, internal id, membership id, tenant, roles, status with
 * dates). The join is resolved SERVER-side via the alias record
 * (lookupLoginByUserId, src/security/iaaaMigration.ts) and carried as a
 * `login` field beside the id — the client renders it, never invents it.
 * A user with no alias resolves to null; the client renders "not recorded",
 * never a fabricated login.
 *
 * Only internal user ids are looked up: system principals
 * ("system:bootstrap", "system:bootstrap-genesis", …) are not ids and are
 * never sent to the alias store — they render verbatim on the client.
 */
import { lookupLoginByUserId } from "./iaaaMigration";
import type { KvLike } from "./kvResilience";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * v1: ids are `v1:` + a long alphanumeric suffix (64 hex on live
 * records). The length floor — not a hex-only rule — is deliberate:
 * test fixtures mint obviously-fake v1 ids with non-hex letters, and
 * the shape test is display/routing only, never an auth decision.
 */
const V1_ID_PATTERN = /^v1:[0-9a-z]{32,}$/i;

/** True when the value is shaped like an internal user id (UUID or v1:64hex). */
export function isInternalUserId(value: string): boolean {
  return UUID_PATTERN.test(value) || V1_ID_PATTERN.test(value);
}

/**
 * Resolve the login for each internal user id via the alias record.
 * Ids are deduped (one store read per unique id); non-id values resolve
 * to null without a store read. The returned map has an entry for every
 * input value, in input order — null means "no alias recorded".
 */
export async function resolveLogins(
  kv: KvLike,
  ids: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const uniqueIds = [...new Set(ids.filter((id) => isInternalUserId(id)))];
  const resolved = new Map<string, string | null>();
  for (const id of uniqueIds) {
    resolved.set(id, await lookupLoginByUserId(kv, id));
  }
  for (const id of ids) {
    result.set(id, resolved.get(id) ?? null);
  }
  return result;
}
