# Completion Report — Issue #3401

## 1. Executive Summary
- **Issue**: #3401 - [Fix] Alpaca sign-in CSRF, environment synchronization, and fallback deployment keys for paper and live
- **PR**: #3403
- **Agent**: #ceo-aimp
- **Status**: Completed / Enrolled in Merge Queue

## 2. Problems Addressed & Root Causes
1. **CSRF Failure (`csrf_invalid` / 403)**:
   - `src/client/AlpacaSignInCard.tsx` called `fetch("/api/broker/connect/alpaca", ...)` and `fetch("/api/broker/disconnect/alpaca", ...)` directly without spreading `...csrfHeaders()` from `src/client/apiFetch.ts`.
   - `src/security/csrf.ts` enforces `csrfGateResult(request)` on state-changing methods (`POST`), rejecting missing `X-CSRF-Token` headers with 403 `csrf_invalid`.
2. **Environment Desynchronization**:
   - `ETradeDynamicMenu.tsx` rendered `<AlpacaSignInCard />` without passing `activeEnv`.
   - `AlpacaSignInCard.tsx` did not subscribe to `useBrokerEnvironment()` and called `readStatus` once without query parameters.
   - `src/agents/routes/brokerConnect.ts` resolved side solely from stored settings without inspecting URL search parameters or request body overrides.
3. **Fallback to Deployment Keys for Both Paper and Live**:
   - `AlpacaTradingPlatform.ready()` previously only called `applyAlpacaPair` when `pair.source === "user"`. When `pair.source === "deployment"`, `this.env` was not updated with the resolved deployment keys and base URL for that side.

## 3. Implementation Details
- **`src/client/AlpacaSignInCard.tsx`**:
  - Added `...csrfHeaders()` to connect and disconnect requests.
  - Added `useBrokerEnvironment()` hook and computed `effectiveEnv = activeEnv ?? brokerEnv`.
  - Updated `readStatus` to fetch `/api/broker/connect/alpaca?environment=${effectiveEnv}` and added `effectiveEnv` to dependency array so it refetches immediately on environment toggles.
  - Included `environment: effectiveEnv` in connect body and query string.
- **`src/client/ETradeDynamicMenu.tsx`**:
  - Passed `activeEnv={isLive ? "PROD" : "TEST"}` to `<AlpacaSignInCard />`.
- **`src/agents/routes/brokerConnect.ts`**:
  - Added support for `?environment=` / `?side=` query parameters and payload fields in `resolveEnvironmentFor` and `resolveSide`.
- **`src/trading/alpaca/platform.ts`**:
  - In `AlpacaTradingPlatform.ready()`, when `pair.source === "user" || pair.source === "deployment"`, applies `pair` to `this.env`, sets `ALPACA_BASE_URL: baseUrl`, and refreshes `this.alpacaData`.
- **`src/services/marketDataResearch.ts`**:
  - Updated `AlpacaMarketDataProvider.getApiKey` and `getApiSecret` to fall back to `ALPACA_LIVE_*` or `ALPACA_PAPER_*` when generic keys are absent.
- **Tests**:
  - Added `tests/alpaca_signin_3401.test.ts` defending deployment key fallback for both paper and live, and explicit environment query/payload routing.
  - Added `tests/alpaca_signin_card_3401.test.tsx` defending CSRF header transmission on connect and disconnect, and dynamic reactivity to active environment changes.
  - Added `changelog.d/3401-alpaca-signin-csrf-deployment-keys.md`.

## 4. Verification & Evidence
- Vitest suite: 264 existing tests passed, 8 new tests passed in `tests/alpaca_signin_3401.test.ts` and `tests/alpaca_signin_card_3401.test.tsx`.
- Policy Gate: PASS (linked issue, agent hashtag, changelog fragment, zero deletions).
- Pre-merge checks: Gitleaks pass, Policy Gate pass, Load Active Environment pass.

