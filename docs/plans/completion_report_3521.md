# Completion Report: Issue #3521 (Stock Copilot Tab Exclusivity)

## Completion report (gitops §15 — fill on close; the single document for this issue)

- **Issue / Pull request / Integration (merged, target, resulting commit):**
  - Issue: [#3521](https://github.com/Qunsultant/cfagent/issues/3521)
  - PR: [#3524](https://github.com/Qunsultant/cfagent/pull/3524)
  - Target: `main`
  - Resulting commit: [`646fcffa`](https://github.com/Qunsultant/cfagent/commit/646fcffadb7c7f4c4421bdbd87b9a87a3322823c)

- **Implementation (key decisions, alternatives, scope exclusions):**
  - **Root Cause Resolution:** In PR #3454, a "uniform shell" was introduced that forced the shared conversational stream and composer beneath `StockCopilotPanel`, clamping the custom panel to 45vh/50% height. Because `StockCopilotPanel` is an autonomous trading loop dashboard with telemetry, controls, and position tables, this caused visual overlap, element collision, and dual scrollbars on `?tab=chat&view=stock`.
  - **View Exclusivity Restored:** Restored dedicated surface exclusivity in `AgentChatTabContent.tsx`. When `hasCustomSurface(currentCopilot)` is true (e.g. Stock Copilot with `mode: "custom"`), the custom dashboard panel renders exclusively across the tab viewport (`flexGrow: 1`, `overflowY: "auto"`), omitting the conversational hero, action bar, messages stream, and chat input bar.
  - **Single-Container Scroll Flow:** Removed `max-height: 45vh; overflow-y: auto;` from `stockCopilotPanel.css` `.scp-panel`, allowing the outer tab surface container to handle scrolling naturally without cramped internal viewport clipping.
  - **Registry Contract Clarified:** Documented in `copilotRegistry.ts` that `mode: "custom"` renders dedicated copilot dashboards exclusively, while `mode: "chat"` renders conversational streams.

- **Test evidence (red, green, regression, integration/evaluation; CI runs; post-merge checks):**
  - **Unit Tests:** `tests/chat_copilots_subtabs_3449.test.tsx` updated to assert that `view=stock` renders `StockCopilotPanel` exclusively without `.chat-input-bar` or `.messages-stream`, while conversational views (`general`, `options`) render the stream, welcome hero, and input composer. All 11 tests pass.
  - **CI & Merge Queue:** PR #3524 checks (Policy Gate, Secret Scanning, Fast Gates typecheck+build, 4/4 test shards, CodeQL) all passed 100% green.
  - **Post-Merge Verification on `main`:** Verified green run `42205561326` on `main`.

- **Change management (actual: change type, impacted surfaces, migration and data impact, rollout plan, rollback plan, communication, changelog entry):**
  - Change Type: Bug Fix / UX Polish.
  - Impacted surfaces: `src/client/chat/AgentChatTabContent.tsx`, `src/client/stockCopilotPanel.css`, `src/client/chat/copilotRegistry.ts`, `tests/chat_copilots_subtabs_3449.test.tsx`.
  - Migration: Automatic; fixes layout for all users visiting `?tab=chat&view=stock`.
  - Changelog entry: `changelog.d/3521-stock-copilot-tab-exclusivity.md`.

- **Conformance (actual: UX primitives/tokens used, architecture boundaries followed, reused surfaces, rework justification, regression pins):**
  - Followed UX architecture token-only styling.
  - Strictly followed GitOps §22 zero deletions policy.
  - Reused existing `StockCopilotPanel` and `CapabilityNavBar` components without architecture drift.

- **Agentic design (actual: allocation as built, delegation path, evaluator, task records, policies/budgets, never-list compliance):**
  - Clean separation of concerns between conversational copilots (`mode: "chat"`) and autonomous loop monitoring dashboards (`mode: "custom"`).

- **Value and impact (value created, capabilities enhanced, competencies improved, value proposition, delivery channels, user journey):**
  - Permanently eliminates UI overlap, squished panels, and fighting scrollbars on `https://agent.openaimp.com/?tab=chat&view=stock`.
  - Gives traders an unobstructed, full-viewport autonomous trading loop control center.

- **Risk and limitations (security, tenant isolation, compatibility, performance/cost; known test-coverage gaps stated explicitly):**
  - Zero risk to options or general copilot conversational workflows.

- **Delivery and release (migration, feature flag, deployment impact, rollback; release state, version, environment):**
  - Merged directly into `main` via PR #3524 at commit `646fcffadb7c7f4c4421bdbd87b9a87a3322823c`.

- **Process docs updated (file + commit, or none with reason):**
  - None required; pure UI/UX bug fix.

- **Next-step gate (PASS / BLOCKED + reason):**
  - PASS. Issue #3521 is fully resolved and verified on `main`.

