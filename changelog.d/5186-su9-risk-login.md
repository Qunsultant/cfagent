### Changed
- Replaced the local `CardHeader` helper in `src/client/RiskAnalysisPanel.tsx` with the shared `CardHeader` UI primitive from `src/client/components/ui` across all 11 card headers (#5186, S-U9).
- Re-skinned `renderLoginPage` in `src/security/githubOAuth.ts` to mirror the app shell chrome using `SERVER_PALETTE` tokens only and regenerated `LOGIN_GOLDEN` in `tests/server_palette.test.ts`, leaving `/checkout/sandbox` (`src/server/routes/core.ts`) untouched (#5186, S-U9).
