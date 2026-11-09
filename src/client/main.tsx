import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";
import { BootToast } from "./BootToast";
import {
  signedInMessage,
  stripAuthOutcomeParam,
  isDefaultLandingUrl,
  bootReturnTarget,
} from "./authOutcome";
import { ToastProvider } from "./components/ui";
import { applyThemeToDocument, getStoredTheme, initThemeListener } from "./theme";
import { applyTypographyToDocument, getStoredFontScale, getStoredFontStyle, initTypographyListener } from "./typography";
import { applyDensityToDocument, getStoredDensity, initDensityListener } from "./designTokens";
import "./styles.css";
import "./tokens.css";
import "./components/ui/primitives.css";

// Issue #3891 — build marker: the short commit sha this bundle was built
// from (substituted by the `define` in vite.config.ts). Exposed on window
// so post-deploy QA can prove the live bundle is the one this deploy
// built; a stale deploy serves an older sha and fails the qa-smoke check
// instead of reporting success.
declare const __BUILD_COMMIT__: string;
(window as any).__BUILD_COMMIT__ = __BUILD_COMMIT__;

// Startup applies preferences without writing storage.
applyThemeToDocument(getStoredTheme());
applyTypographyToDocument(getStoredFontScale(), getStoredFontStyle());
applyDensityToDocument(getStoredDensity());
const disposeThemeListener = initThemeListener();
const disposeDensityListener = initDensityListener();
const disposeTypographyListener = initTypographyListener();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeThemeListener();
    disposeDensityListener();
    disposeTypographyListener();
  });
}

const devUser = import.meta.env.DEV
  ? {
      login: "local_analyst",
      name: "Institutional Analyst",
      avatar: "https://avatars.githubusercontent.com/u/82253453?v=4",
    }
  : null;

const user = (window as any).__USER__ || devUser;

if (!user) {
  // #1254 PR-B: the exact /auth/login route is deleted; the
  // generic provider route for the default provider (github)
  // is the login start. Remember the page being refreshed so the
  // post-login boot returns to it instead of the default tab.
  // #3015: the same page is ALSO carried as a ?target= parameter
  // into startLogin, which seals it into signed state — so the
  // return survives even when sessionStorage is unavailable
  // (private mode), and the signed-state path agrees with the
  // sessionStorage path instead of racing it. The storage save
  // is deliberately isolated: a private-mode failure must never
  // wipe the target the ?target= leg carries.
  const next = bootReturnTarget(
    window.location.pathname,
    window.location.search,
    window.location.hash
  );
  try {
    // #2402: the saved return page never carries the outcome
    // parameter, so a post-login restore cannot reshow an outcome.
    if (next !== "") window.sessionStorage.setItem("auth:next", next);
  } catch {
    // sessionStorage can be unavailable (private mode); the login still works.
  }
  window.location.replace(
    next !== "" && next !== "/"
      ? `/auth/login/github?target=${encodeURIComponent(next)}`
      : "/auth/login/github"
  );
} else {
  // #2402: one-time sign-in confirmation. The parameter is stripped
  // before anything else reads the URL, so a refresh never reshows
  // it; the message text comes from the verified boot user, never
  // from the URL.
  const bootMessage = signedInMessage(
    (window as any).__AUTH_OUTCOME__,
    user.name ?? user.login
  );
  let cleaned = window.location.href;
  try {
    cleaned = stripAuthOutcomeParam(window.location.href);
    if (cleaned !== window.location.href) {
      window.history.replaceState({}, "", cleaned);
    }
  } catch {
    // Ignore history failures; the toast still shows once, and the
    // parameter is harmless if it survives.
  }
  // Restore the page saved before the login redirect, before Chat reads
  // the URL, so a refresh lands back on the same tab/view.
  // #3015: restore ONLY on the default landing. After a
  // target-carrying callback the URL already IS the bookmarked
  // page, and a stale saved page must never clobber it.
  try {
    const next = window.sessionStorage.getItem("auth:next");
    if (
      next &&
      next.startsWith("/") &&
      !next.startsWith("//") &&
      isDefaultLandingUrl(cleaned)
    ) {
      window.sessionStorage.removeItem("auth:next");
      window.history.replaceState({}, "", next);
    }
  } catch {
    // Ignore storage failures; the default tab is still valid.
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ToastProvider>
        <BootToast message={bootMessage} />
        <Chat user={user} />
      </ToastProvider>
    </React.StrictMode>
  );
}
