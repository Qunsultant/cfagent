/**
 * Report-confirmation TTL (24h), moved verbatim from OrchestratorAgent's
 * private static REPORT_CONFIRMATION_TTL_MS by issue #2942: the route
 * dispatcher that consumed it moved into routeRequest.ts, where the class
 * static is not reachable, so the value lives here and both the class
 * (reportDispatchContext) and the dispatcher import it.
 */
export const REPORT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
