/**
 * #6164 (parent #945) — one identity rendering for every IAAA admin surface.
 *
 * CONSISTENT INFORMATION EVERYWHERE: the same entity renders the same way
 * everywhere — `login (internal-id)` when the server resolved a login,
 * `not recorded (internal-id)` when no alias exists, and a system principal
 * ("system:…") or issuer:subject verbatim. The client NEVER invents a login:
 * every login shown here arrived in a server `login` field.
 */
import type { ReactNode } from "react";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V1_ID_PATTERN = /^v1:[0-9a-z]{32,}$/i;

/** True when the value is shaped like an internal user id (UUID or v1:…). */
export function isInternalUserId(value: string): boolean {
  return UUID_PATTERN.test(value) || V1_ID_PATTERN.test(value);
}

/**
 * Plain-text form, for notices and labels: `login (id)`, or
 * `not recorded (id)` when the server resolved no alias.
 */
export function formatIdentityText(
  login: string | null | undefined,
  internalUserId: string,
): string {
  return login ? `${login} (${internalUserId})` : `not recorded (${internalUserId})`;
}

/**
 * Plain-text form for a principal that may be an internal id or a
 * system/issuer principal: ids render as {@link formatIdentityText},
 * anything else renders verbatim.
 */
export function formatPrincipalText(
  login: string | null | undefined,
  principal: string,
): string {
  return isInternalUserId(principal) ? formatIdentityText(login, principal) : principal;
}

/**
 * Table-cell form: the login (or "not recorded") plus the id in code.
 * Use for every internal-user-id cell on the IAAA admin surfaces.
 */
export function Identity({
  login,
  id,
}: {
  login: string | null | undefined;
  id: string;
}): ReactNode {
  return (
    <>
      {login ?? "not recorded"} <code className="ui-mono">({id})</code>
    </>
  );
}
