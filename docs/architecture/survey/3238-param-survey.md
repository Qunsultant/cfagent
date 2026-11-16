> **Filed into the repo 2026-11-16** (issue #4792) — copy of `~/workspace/3238-param-survey.md` as written on its stated base (tree `cfagent-urlparams @ 5a377e38`, 2026-11-05). Survey body below unchanged.

# #3238 param-ownership survey (2026-11-05, tree cfagent-urlparams @ 5a377e38)

## Mechanism (verified)
`src/client/router.ts` `buildSearchWithTab`: set `tab`, preserve every other
param. Only `view` is scoped (`navigateToTab` deletes it when the destination
sets no view). `orderTab` (S2 #3088) never got a router rule → leaks.

## Param inventory (page-owned, beyond `tab`/`view`)
- `orderTab` — OrderTicketPanel (`param: "orderTab"`), read at :164. Owner: `order`.
- `riskTab` — RiskAnalysisPanel (`param: "riskTab"`). Owner: the risk page's route id — confirm from Chat render.
- `reportsTab` — ReportsPanel (`param: "reportsTab"`). Owner: reports page's route id — confirm.
- `iaaaTab` — IaaaAdminPanel (`param: "iaaaTab"`). Owner: platform-admin section id — confirm.
- `assetClass` — one-shot seed: deep link `?tab=order&assetClass=options` → hub consumes + strips, writes `orderTab=options` (hub :1224-1250). Owner: `order` (must survive the navigation that carries it; hub strips it on arrival).
- `research` — OptionsHub :117 + OptionsResearchPanel :797/:816 (writes via replaceState on route change). Owner: options routes — confirm exact route ids.
- `discoveryView` — OptionsHub :108. Owner: options routes.
- `run` — WorkflowRunsPanel :421. Owner: workflow-runs route id — confirm.
- `screenerTab` — LEGACY read-only alias for `view` in ScreenersHub / OptionsHub / StockHub. Owner: those three hubs' route ids (dropping it elsewhere only cleans URLs; the hubs keep reading it as an alias while on their pages).
- `view` — shared sub-view param, already scoped by navigateToTab. Keep existing rule.
- One-shot self-cleaning (NOT registry-owned; owners strip them on arrival): `etrade_auth`, `etrade_connect_error` (hub :712-729), auth outcome (main.tsx strips at boot), `assetClass` (above).

## Still to confirm in implementation
- Route id for each host page: RiskAnalysisPanel, ReportsPanel, IaaaAdminPanel, ScreenersHub, StockHub, OptionsHub, WorkflowRunsPanel, SearchHub, MarketDataResearchHub — from Chat.tsx render switch + routes.ts.
- nav-config.json deepLinks shape (entries are strings? earlier python failed on `.get`) + whether autopilot has a deep-link entry; add one if missing.
- `useUrlSyncedTabs` write path: does handleTabChange preserve params (same-page writes must keep working)? Check before changing buildSearchWithTab.
- `q` param: no direct reader found in the first grep — find its reader or drop it from the registry (unknown params: decide drop vs preserve; prefer drop on cross-page nav only for KNOWN page-owned params, preserve unknowns to avoid breaking OAuth/deep-link flows — record the decision in the issue/PR).

## Design (as filed)
Registry in router.ts: param → owning route ids. On tab change, drop params
the destination does not own. Same-tab navigation keeps everything. Autopilot:
clean canonical `?tab=autopilot` + deep-link entry if missing.
