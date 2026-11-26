/**
 * What remains of the original GitHub OAuth module after #1254:
 * the logout handler and the login-page renderer. The GitHub
 * login FLOW itself is the declarative factory registration in
 * providers.ts (PR-A), served by the generic registry routes;
 * PR-B deleted the wiring-off legacy flow that used to live here
 * (handleLogin / handleOAuthCallback / exchangeGithubCode /
 * fetchGithubProfile) together with the exact /auth/login +
 * /auth/callback routes that reached it.
 */
import type { Env, SessionData } from "../types";
import { resolveEnvironmentConfig } from "../config/environment";
import { clearSessionCookie, getSessionIdCandidates, getSession, deleteSession } from "./session";
import { invalidateSessionCache } from "./sessionCache";
import {
  buildLogoutAuditEventInput,
  buildLogoutAuditSkippedEventInput,
  recordWiredAuthAudit,
} from "./iaaaAuthAudit";
import type { AuditStore } from "./iaaaAudit";
import { logoutAuditTenant } from "./iaaaGates";
import { revokeStoredTokens } from "./etradeOAuth";
import { SERVER_PALETTE } from "../theme/serverPalette";
import {
  authOutcomeNoticeHtml,
  type AuthOutcomeCode,
} from "./authOutcome";
import { validateReturnTarget } from "./returnTarget";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/**
 * Audit seam for the logout hook (Phase 2b-part1). The caller —
 * server.ts /auth/logout — supplies the wiring flag, a store, and
 * the raw tenant id; logoutAuditTenant (iaaaGates.ts, a leaf
 * module) resolves them to a tenant or null. Without a resolved
 * tenant the hook is dormant and nothing is recorded. The tenant
 * is never defaulted here: inventing one would fabricate
 * attribution. No import of providers.ts here on purpose:
 * providers.ts imports this module, so importing the wiring
 * predicate back would create a cycle.
 */
export interface LogoutAuditOptions {
  wiringEnabled?: boolean;
  auditStore?: AuditStore;
  tenantId?: string;
}

export async function handleLogout(env: Env, request: Request, options?: LogoutAuditOptions): Promise<Response> {
  // Issue #3515 S3 batch 8 — env-wired logger (never an empty-env sink, #5587).
  const structuredLog = createStructuredLogger(createObservabilitySink(env), {
    component: "security/githubOAuth",
  });
  // Issue #329: only a UUID-shaped cookie can name a session; skipping the
  // read (and the delete) for anything else keeps junk cookies off the
  // session store. A browser can send more than one `session_id` (a stale
  // Domain/Path variant first) — deleting only the first candidate would
  // leave the live session alive, so every candidate is deleted and the
  // revocation/audit describe the one that actually resolves.
  const sessionIds = getSessionIdCandidates(request);

  if (sessionIds.length > 0) {
    let sessionId = sessionIds[0];
    try {
      // Authoritative read from the session store (not KV): logout must see the
      // real record even if a cache layer still holds a copy.
      let session: SessionData | null = null;
      for (const candidate of sessionIds) {
        session = await getSession(env, candidate);
        if (session) {
          sessionId = candidate;
          break;
        }
      }
      if (session?.githubLogin) {
        await revokeStoredTokens(env, session.githubLogin);
      }
      // #945 Phase 2b-part1 logout audit hook: record BEFORE
      // deleteSession, only for wired sessions (internalUserId
      // present), only when wiring is ON, and only when a tenant
      // resolves. Best-effort: recordWiredAuthAudit never throws,
      // and a failed write never changes the logout outcome.
      const tenantId = logoutAuditTenant({
        wiringEnabled: options?.wiringEnabled ?? false,
        tenantId: options?.tenantId,
      });
      if (tenantId && options?.auditStore) {
        // #1760 — the skip stops being silent: a legacy session
        // record (no internalUserId) gets a logout_audit_skipped
        // event instead of nothing. A missing session record gets
        // no event: no session ended, so there is nothing to
        // audit, and emitting for unknown cookies would spam the
        // log. A failed write is fail-visible (warned) and never
        // fail-blocking: logout proceeds regardless (D-2).
        const auditResult = session?.internalUserId
          ? await recordWiredAuthAudit(
              options.auditStore,
              buildLogoutAuditEventInput({
                internalUserId: session.internalUserId,
                tenantId,
                timestamp: Date.now(),
                correlationId: sessionId,
              }),
            )
          : session
            ? await recordWiredAuthAudit(
                options.auditStore,
                buildLogoutAuditSkippedEventInput({
                  tenantId,
                  timestamp: Date.now(),
                  correlationId: sessionId,
                  reason: "LEGACY_SESSION_NO_INTERNAL_USER_ID",
                }),
              )
            : null;
        if (auditResult && !auditResult.ok) {
          structuredLog.warn("githubOAuth.logout_audit_write_failed", {
            message: `[logout-audit] audit write failed (${auditResult.code}); logout proceeded unaudited`,
            code: auditResult.code,
          });
        }
      }
    } catch {
      // Logout must never fail the request; the cookie is cleared regardless.
    }
    for (const candidate of sessionIds) {
      try {
        invalidateSessionCache(candidate);
        await deleteSession(env, candidate);
      } catch {
        // Same rule per candidate: one failed delete never blocks the rest.
      }
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

/**
 * #945 Google-as-plugin — composable login page.
 *
 * With no second argument (or an empty list) this renders exactly
 * the legacy GitHub-only page, byte for byte. When server.ts passes
 * the enabled providers (computed there and passed in, so this
 * renderer stays registry-agnostic), the
 * page renders one icon-only link per provider, href
 * /auth/login/<id>, with the provider's brand mark as the whole
 * button and "Sign in with <displayName>" as its accessible name
 * (#3363). Provider ids and display names are HTML-escaped; marks
 * are monochrome (currentColor) so the server-palette gate (#678)
 * still sees zero colour literals in this file.
 */
export interface LoginPageProvider {
  id: string;
  displayName: string;
}

export function renderLoginPage(
  env: Env,
  providers?: LoginPageProvider[],
  outcome?: AuthOutcomeCode | null,
  returnTarget?: string | null
): string {
  // Phase 3 (#6550): the app name now resolves from
  // environment.config.json (defaults.app.name, "NextGenTP"); a
  // still-set env var wins.
  const appName = resolveEnvironmentConfig(env).workerSettings.app.name || "NextGenTP";
  const multiProvider = Array.isArray(providers) && providers.length > 0;
  // #3015: a validated return target rides on every provider
  // button, so switching providers mid-flow (GitHub → Google, or
  // back to /login and another button) keeps the same target —
  // each button seals it into its own signed state at startLogin.
  // An absent or refused target renders the plain buttons,
  // byte-identical to before.
  const validatedTarget = returnTarget ? validateReturnTarget(returnTarget) : null;
  const targetSuffix = validatedTarget
    ? `?target=${encodeURIComponent(validatedTarget)}`
    : "";
  // #2402: an outcome notice renders only when a failure code is
  // passed; with no outcome the section below reproduces the
  // previous bytes exactly (the no-arg page is golden-pinned).
  const noticeStyle =
    `border:1px solid ${SERVER_PALETTE.cardBorder};` +
    `border-left:3px solid ${SERVER_PALETTE.danger};` +
    `background:${SERVER_PALETTE.surfaceRaised};` +
    `border-radius:12px;padding:0.85rem 1rem;margin-bottom:1.5rem;` +
    `text-align:left;font-size:0.9rem;line-height:1.5;color:${SERVER_PALETTE.textSecondary}`;
  const notice = authOutcomeNoticeHtml(outcome ?? null, noticeStyle);
  const noticeSection = notice ? `    ${notice}\n\n` : "\n";
  const intro = multiProvider
    ? "Sign in with your authorized credentials to access your trading workspace."
    : "Sign in with your GitHub account to access your trading workspace.";
  const githubMark = `<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  // #3363: Google's mark is the single-path monochrome "G" from
  // simple-icons, currentColor only — no brand-colour literals,
  // so the server-palette gate (#678) still passes this file.
  const googleMark = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>`;
  // #3363: icon-only provider links — the mark is the whole button
  // and the name lives in the accessible name, never in visible
  // text. A provider with no mark yet falls back to its initial,
  // so the link is never empty.
  const markForProvider = (p: LoginPageProvider): string => {
    if (p.id === "github") return githubMark;
    if (p.id === "google") return googleMark;
    const initial = (p.displayName || p.id).slice(0, 1).toUpperCase();
    return `<span class="provider-initial" aria-hidden="true">${escapeHtml(initial)}</span>`;
  };
  const iconLink = (href: string, id: string, displayName: string, mark: string): string =>
    `<a href="${href}" class="btn btn-${escapeHtml(id)} provider-icon" aria-label="Sign in with ${escapeHtml(displayName)}" title="Sign in with ${escapeHtml(displayName)}">${mark}</a>`;
  const buttons = multiProvider
    ? providers!
        .map((p) =>
          iconLink(
            `/auth/login/${encodeURIComponent(p.id)}${targetSuffix}`,
            p.id,
            p.displayName,
            markForProvider(p)
          )
        )
        .join("\n      ")
    : iconLink("/auth/login", "github", "GitHub", githubMark);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(appName)} — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: ${SERVER_PALETTE.surface};
      color: ${SERVER_PALETTE.textPrimary};
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .shell-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.875rem 1.5rem;
      background: ${SERVER_PALETTE.surfaceRaised};
      border-bottom: 1px solid ${SERVER_PALETTE.cardBorder};
    }
    .shell-brand {
      display: inline-flex;
      align-items: center;
      gap: 0.625rem;
      font-size: 0.95rem;
      font-weight: 700;
      color: ${SERVER_PALETTE.textPrimary};
      letter-spacing: -0.015em;
    }
    .shell-brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: ${SERVER_PALETTE.indigo500};
      color: ${SERVER_PALETTE.onGradient};
    }
    .shell-scope {
      font-size: 0.75rem;
      font-weight: 600;
      color: ${SERVER_PALETTE.textMuted};
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      border: 1px solid ${SERVER_PALETTE.cardBorder};
      background: ${SERVER_PALETTE.card};
    }
    .shell-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: ${SERVER_PALETTE.card};
      border: 1px solid ${SERVER_PALETTE.cardBorder};
      border-radius: 12px;
      padding: 2.25rem 2rem;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 12px 32px ${SERVER_PALETTE.blackAlpha60};
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      background: ${SERVER_PALETTE.surfaceRaised};
      border: 1px solid ${SERVER_PALETTE.cardBorder};
      border-radius: 12px;
      margin-bottom: 1.25rem;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
      color: ${SERVER_PALETTE.textPrimary};
    }
    .brand-gradient {
      color: ${SERVER_PALETTE.accent};
    }
    .subtitle {
      color: ${SERVER_PALETTE.textMuted};
      font-size: 0.9rem;
      line-height: 1.55;
      margin-bottom: 1.75rem;
    }
    .btn-stack {
      display: flex;
      flex-direction: row;
      justify-content: center;
      gap: 0.85rem;
      margin-bottom: 1.75rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: ${SERVER_PALETTE.onGradient};
      color: ${SERVER_PALETTE.card};
      text-decoration: none;
      padding: 0;
      border-radius: 50%;
      font-size: 0.95rem;
      font-weight: 600;
      width: 48px;
      height: 48px;
      flex: none;
      transition: background 0.15s ease, transform 0.15s ease;
      border: 1px solid ${SERVER_PALETTE.cardBorder};
      position: relative;
    }
    .btn:hover {
      background: ${SERVER_PALETTE.slate100};
      transform: translateY(-1px);
    }
    .btn:active {
      transform: translateY(0);
    }
    .btn svg {
      width: 22px;
      height: 22px;
      fill: ${SERVER_PALETTE.card};
      flex-shrink: 0;
    }
    .card-footer {
      border-top: 1px solid ${SERVER_PALETTE.cardBorder};
      padding-top: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      align-items: center;
    }
    .security-note {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.775rem;
      color: ${SERVER_PALETTE.textMuted};
    }
    .security-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${SERVER_PALETTE.green500};
    }
    .back-link {
      color: ${SERVER_PALETTE.accent};
      font-size: 0.825rem;
      font-weight: 500;
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .back-link:hover {
      color: ${SERVER_PALETTE.textPrimary};
    }
  </style>
</head>
<body>
  <header class="shell-header">
    <div class="shell-brand">
      <span class="shell-brand-mark" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L22 8.5V15.5L12 22L2 15.5V8.5Z"></path>
        </svg>
      </span>
      <span>${escapeHtml(appName)}</span>
    </div>
    <span class="shell-scope">Sign In</span>
  </header>
  <main class="shell-main">
    <div class="card">
      <div class="logo-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${SERVER_PALETTE.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L22 8.5V15.5L12 22L2 15.5V8.5Z"></path>
          <line x1="12" y1="22" x2="12" y2="15.5"></line>
          <polyline points="22 8.5 12 15.5 2 8.5"></polyline>
        </svg>
      </div>
      <h1>Sign in to <span class="brand-gradient">${escapeHtml(appName)}</span></h1>
      <p class="subtitle">${intro}</p>
${noticeSection}      <div class="btn-stack">
        ${buttons}
      </div>

      <div class="card-footer">
        <div class="security-note">
          <span class="security-dot" aria-hidden="true"></span>
          <span>Protected by W3C Agent DIDs &amp; deterministic risk gates</span>
        </div>
        <a href="/" class="back-link">&larr; Back to ${escapeHtml(appName)} Home</a>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
