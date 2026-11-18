/**
 * Issue #5699 — the one JSON shape for an unauthenticated HTTP refusal.
 *
 * The repository had two idioms for the same event: `Response.json({ error:
 * "Unauthorized: Please log in." }, { status: 401 })` in some branches and
 * `new Response("Unauthorized", { status: 401 })` in others (thirteen sites
 * before this module). A client that parses JSON cannot read the bare-text
 * body — that is exactly how #5625 reached a user as "Unexpected token 'U',
 * "Unauthorized" is not valid JSON" instead of an auth message.
 *
 * Deliberate exception: a WebSocket *upgrade* refusal (`src/api/wsRoutes.ts`)
 * stays plain text — the handshake's body is not parsed by the client, so a
 * JSON payload there would be noise.
 */

/** Stable code a client can match on, independent of the message text. */
export const UNAUTHORIZED_CODE = "UNAUTHORIZED";

/** The default refusal text; callers with a specific action override it. */
export const UNAUTHORIZED_MESSAGE =
  "Unauthorized: sign in again — your session is missing or has expired.";

/** One JSON 401 for every HTTP API refusal. */
export function unauthorizedJson(message: string = UNAUTHORIZED_MESSAGE): Response {
  return Response.json({ code: UNAUTHORIZED_CODE, error: message }, { status: 401 });
}
