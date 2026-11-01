/**
 * Issue #1764 (#1717 slice: workflow + service identity) — background
 * identity attribution for unattended work.
 *
 * The F-32 gap, stated plainly: background dispatches and user-driven
 * forwards both carried only `x-user-login`, so downstream code could
 * not distinguish "background" from "user" by the header alone — it
 * could only do so by knowing the configured service login value.
 * This module makes the distinction explicit on the wire AND
 * trustworthy at the reader:
 *
 * - Unattended Worker dispatches (scheduled() + queue()) set
 *   `x-actor-kind: background` alongside `x-user-login` via
 *   backgroundDispatchHeaders(). Those dispatches build a fresh
 *   Request with explicit headers, so a client-supplied header
 *   cannot leak into them.
 * - Attribution authority is NEVER the header alone. resolveActorAttribution
 *   returns "background" only when the login equals the configured
 *   service login (the serviceDispatch rule: with no configuration,
 *   nothing is a service dispatch). A `background` header on any
 *   other login — e.g. a client-spoofed header that survived a
 *   user-forward copy — resolves to "user" with an anomaly flag,
 *   fail-closed to user attribution. The header is corroboration
 *   (headerCorroborates), not authority, so a reader of headers or
 *   audit records no longer needs to know the service login value
 *   to see that a record is background work — but a reader that
 *   checks authority still checks the login equality.
 *
 * Nothing here changes enforcement: serviceDispatch remains the
 * gate, and this module never grants, denies, or reclassifies a
 * dispatch — it only names the actor kind for audit and logs.
 */
import { isLoginShaped } from "./serviceIdentity";

/** Wire header carrying the actor kind on internal dispatches. */
export const BACKGROUND_ACTOR_HEADER = "x-actor-kind";

export type ActorKind = "background" | "user";

export interface ActorAttribution {
  /** The login carried on the dispatch, or null when none was carried. */
  login: string | null;
  actorKind: ActorKind;
  /** True when the dispatch also carried x-actor-kind: background. */
  headerCorroborates: boolean;
  /**
   * Set when the header claimed background but the login is not the
   * configured service login (or no service login is configured):
   * the claim is untrusted and attribution fell back to user.
   */
  anomaly?: string;
}

type HeaderBag =
  | Headers
  | Record<string, string | undefined>
  | null
  | undefined;

function readHeader(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return record[key] ?? null;
    }
  }
  return null;
}

/**
 * Headers for an unattended dispatch under `login`: the existing
 * x-user-login plus the explicit background marker. The existing
 * header is kept — nothing is replaced — so every consumer that
 * reads x-user-login today keeps working unchanged.
 */
export function backgroundDispatchHeaders(
  login: string
): Record<string, string> {
  return {
    "x-user-login": login,
    [BACKGROUND_ACTOR_HEADER]: "background",
  };
}

/**
 * Resolve the actor kind for a dispatch from its headers and the
 * configured service login. Pure and total: unknown/missing values
 * resolve to user, never to background.
 */
export function resolveActorAttribution(
  headers: HeaderBag,
  serviceLogin: string | null
): ActorAttribution {
  const rawLogin = readHeader(headers, "x-user-login");
  const login = isLoginShaped(rawLogin) ? (rawLogin as string) : null;
  const headerKind = readHeader(headers, BACKGROUND_ACTOR_HEADER);
  const headerCorroborates = headerKind === "background";
  if (login !== null && serviceLogin !== null && login === serviceLogin) {
    return { login, actorKind: "background", headerCorroborates };
  }
  if (headerCorroborates) {
    return {
      login,
      actorKind: "user",
      headerCorroborates,
      anomaly:
        "x-actor-kind: background claimed for a login that is not the configured service login — treated as user work, not background work (#1764).",
    };
  }
  return { login, actorKind: "user", headerCorroborates: false };
}
