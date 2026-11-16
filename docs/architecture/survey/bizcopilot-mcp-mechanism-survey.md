# BizCopilot: MCP tools vs deterministic branches — decision brief

Prepared 2026-11-15 ~16:05 EST for Mars's question (main chat, 15:41 EST):
"why deterministic? didn't you know how other copilots are calling mcp tools?
why there is not mcp tool for bizcopilot?"

Verified against origin/main tip `5b42eae4` (checked 2026-11-15 ~16:00 EST).
All file/line claims below are from that tip, not from the chat answers.

## In plain business terms

Today there are two ways the chat can do a job for you:

- **Deterministic branches (what BizCopilot uses now):** the chat matches your
  exact wording against a fixed list of commands — "Create tenant acme" works,
  "Create a tenant" does not, because no name was given. It is exact, testable,
  and the model never decides anything: the code runs the page's own route and
  the model only narrates the result. The cost is brittleness — every new
  phrasing is a new defect, which is exactly what #4701 was.
- **MCP tools (what Stock Copilot uses):** the chat is handed a menu of tools
  with descriptions ("drive one stage of a stock run", "draft a payment") and
  the model picks the tool, fills in the details, and asks you when a detail
  is missing. The cost is that the model is now in the decision path for
  *which* action runs and *with what details* — the action itself is still
  plain code behind the same gates and audit.

Nothing about money safety lives in the wording matcher. The payment gate,
the approval wait, the verified-payment check, and the audit all live in the
code that runs the action — and that code is identical under either mechanism.
What changes is only who picks the action and extracts its details: fixed
patterns, or the model.

## What exists today (verified)

- **No BizCopilot MCP tool exists.** The catalog is `src/mcps/openaimp/`
  (26 files). It has trading, market data, DB reads, job pipeline, payments,
  web fetch/search — and zero tenant/account/channel commands. The capability
  lives only as HTTP routes plus the three deterministic branches.
- **The MCP mechanism is real and used.** `src/mcps/openaimp/jobStageControlCommands.ts`
  is the precedent: `StockCopilotStageControlCommand` implements
  `IMcpToolCommand` with a name, description, JSON + zod schema, and an
  `execute()` that calls the existing control plane and audits the call.
  Registration is one line in `McpToolFactory` (`src/mcps/openaimp/commands.ts`,
  cf. line 1756). Think auto-merges discovered tools into every turn as
  `tool_openaimp_<name>`, and `src/agents/chatPrompt.ts` carries steering
  lines naming them verbatim.
- **The deterministic surface is 18 intents in 3 files** (1,563 lines total):
  - Tenants, `src/services/bizCopilotTenants.ts` (405 lines): list, create,
    detail, settings-read, settings-update, membership-write-refused.
  - Accounts, `src/services/bizCopilotAccounts.ts` (746 lines): lookup,
    grant-subscription, grant-unlimited-free, revoke-unlimited-free,
    grant-free-access, revoke-free-access, grant-history, move-current-pricing.
  - Channels, `src/services/bizCopilotChannels.ts` (412 lines): show, enable,
    disable, enforcement.
  - Wired pre-turn in `src/agents/orchestrator.ts` (~2713–2726): each branch
    runs, hands its outcome to the model as context, and the model narrates it.
- **The executors are separable from the parsers.** Each service has an
  `executeBizCopilot*Intent(intent, deps)` that takes a parsed intent object
  and calls the page routes. An MCP tool would construct that same intent
  object from validated arguments and call the same executor — the route
  calls, gates, and audit are reused verbatim; only the regex parser retires.

## The three options, concretely

### A. Keep deterministic, land #4706
- Slices 4–8 each add regex parsers in the same shape (one service file per
  surface, one branch call in `orchestrator.ts`).
- Cost per slice is known and small; the #4701 class recurs in milder form
  whenever phrasing varies (each miss is a fall-through denial, fixed by one
  more pattern + one more test, as #4706 does for slices 1–3).
- The filed #4520 Checkout brief's "no prompt in the money path" holds
  literally: the model never selects a money action.

### B. MCP tools for BizCopilot
- One command class per surface (8 tools total: 3 for slices 1–3, 5 for
  slices 4–8), each with an action enum — the same shape as
  `stock_copilot_stage_control` (operation enum: run/rerun/stop/resume/cancel).
  Each `execute()` builds the existing intent object and calls the existing
  executor. Plus: one `registerTool` line each, steering lines in
  `chatPrompt.ts`, and tests per tool.
- The bare "Create a tenant" chip stops being a defect class: the tool schema
  requires `tenantId`, so the model asks for the name instead of denying.
- New risk to name honestly: the model now extracts arguments (which user,
  which plan, which segment). A wrong extraction is a wrong action, refused
  or executed by the same route gate — so the mitigation is schema validation
  plus the route's own gate/audit, not the matcher. Also open for the builder
  to confirm: tools are auto-merged into every turn, so the permission story
  (`src/mcps/openaimp/mcpPermissionPorts.ts`) needs a check that a
  non-operator login cannot even reach a biz tool — the route gate refuses
  them today, but visibility is a separate question.

### C. Hybrid (recommended)
- **Slices 4–8 built on MCP tools** (option B for the new surfaces), because
  that is where phrasing variety explodes — upgrade offers, runs packs,
  billing servicing — and regex would keep producing #4701-class misses.
- **Slices 1–3 keep their deterministic branches** as the fast path; convert
  them to MCP tools later as one follow-up slice reusing the same executors,
  not before slices 4–8.
- **Checkout (#4520) split by money-ness, not by slice:** the MCP tool may
  prepare, present, and pre-select — but capture/confirm runs only through
  the existing deterministic checkout/confirm flow. That keeps the filed
  "no prompt in the money path" true where it matters (the capture), while
  the model does the conversational work around it. If you want the model out
  of Checkout entirely, keep #4520 deterministic and take MCP for the other
  four slices — that split is the one sub-decision inside this option.
- **#4706 lands regardless.** It is the live fix for the chat you use today
  (12 tests, small), and its CI verdict is already watched at 4:54pm today
  (cron `pr-4706-ci-watch`, verified enabled). Choosing MCP does not waste
  it: the parsers it fixes stay as the slices 1–3 fast path until/unless
  they are converted.

## What this decides for slices 4–8

- Order and scope from the earlier discussion brief still stand (Free Runs
  lowest risk, Checkout highest); this decision only changes the mechanism
  each slice is built with.
- The go/no-go pattern (autonomous debrief-after, as for slices 1–3) is
  unaffected — it governs merging, not mechanism.
- The RSI learning loop question is unaffected.

## The decision needed (one tap each)

1. Mechanism for slices 4–8: **A** deterministic / **B** MCP tools / **C** hybrid (recommended).
2. Only if C or B: Checkout capture — model may call the prepare/present tool
   with deterministic confirm underneath, or Checkout stays fully deterministic.
3. Only if B: convert slices 1–3 to MCP tools now, or later as a follow-up.

No build work starts on slices 4–8 until this is settled — that pause, agreed
2026-11-15 ~09:21 EST, still stands.
