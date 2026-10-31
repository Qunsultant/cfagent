export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  // Issue #605: R2 bucket for report PDF blobs. Optional so the #605 code is
  // safe to merge before the bucket is provisioned (falls back to DO storage).
  REPORTS_BUCKET?: R2Bucket;
  // Issue #1548 (slice 0): D1 AgentDB binding (PR #1547). Optional
  // so code is safe before the binding propagates everywhere;
  // absence means the tick keeps legacy behavior (no cross-DO
  // halt read). Never a session or credential store.
  AGENT_DB?: D1Database;
  // Issue #1743: Analytics Engine dataset for the
  // observability stream. Optional so code is safe before the
  // dataset is provisioned; absence means the sink degrades
  // to local logging (never fails the request).
  OBSERVABILITY?: AnalyticsEngineDataset;
  // Issue #1739: queue-backed messaging bindings. Optional so code is
  // safe before the bindings propagate; absence means the legacy
  // in-process bus (the composition root returns null).
  // Issue #2544 (Cloudflare migration step 1): the work queue now
  // HAS a consumer (screener-events, via src/server.ts queue()),
  // and both queues have dead-letter queues.
  SCREENER_EVENTS?: Queue<unknown>;
  SCREENER_EVENTS_DELIVERY?: Queue<unknown>;
  // Issue #2544 — DLQ producer bindings, declared per the migration
  // report §3.2 config shape. The platform delivers failed messages
  // to the DLQ automatically; no code sends to these bindings (they
  // exist so DLQ inspection tooling can bind the queues).
  SCREENER_EVENTS_DLQ?: Queue<unknown>;
  SCREENER_DELIVERY_DLQ?: Queue<unknown>;
  // Issue #329/#604: session + credential store — the SessionStore Durable
  // Object. Sessions, tokens and API keys live here, not in Workers KV
  // (legacy KV fallback removed in #604; the leftover KV bindings in
  // wrangler.jsonc are #606).
  SESSION_STORE?: DurableObjectNamespace;
  /** Owner override for the idle window in ms (default 30 min; production 8h). */
  SESSION_IDLE_TIMEOUT_MS?: string;
  // Issue #1806: Cloudflare Flagship native feature flags binding.
  // Conforms to OpenFeature boolean/value evaluation. Optional so code
  // is safe before the flagship binding is provisioned in wrangler.jsonc.
  FLAGS?: {
    getBooleanValue(flag: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean>;
    getValue?(flag: string, defaultValue: unknown, context?: Record<string, unknown>): Promise<unknown>;
  };
  FEATURE_SCREENER?: string;
  FEATURE_OPTIONS_RESEARCH?: string;
  FEATURE_AUTOPILOT?: string;
  FEATURE_TRADING_ORDERS?: string;
  FEATURE_VOICE_TRADING?: string;
  FEATURE_SOCIAL_PUBLISHING?: string;
  FEATURE_NLQ?: string;
  FEATURE_PAYMENTS?: string;
  FEATURE_SCHEDULES?: string;
  FEATURE_FLAGS?: string;
  SEARCH_AGENT: DurableObjectNamespace;
  // Issue #2230 — TickerAgent DO (market quotes WebSocket, PortThink)
  TICKER_AGENT: DurableObjectNamespace;
  // Issue #1387 — OrchestratorAgent root namespace for sub-agent
  // bootstrap (agents SDK resolves ctx.exports by constructor.name).
  // Optional: the SDK resolves via ctx.exports, not env, so no code
  // reads this binding yet.
  ORCHESTRATOR_AGENT?: DurableObjectNamespace;
  // PR #3 — x402 PaymentsAgent DO (issue #161)
  PAYMENTS_AGENT: DurableObjectNamespace;
  // PR #4 — ScheduledAgent DO (issue #166)
  SCHEDULED_AGENT: DurableObjectNamespace;
  // Issue #261 — ScreenerAgent DO (one agent, one UI, E*TRADE-only)
  SCREENER_AGENT: DurableObjectNamespace;
  // PR #6 — Vectorize binding for VectorMemory (issue #164)
  VECTOR_MEMORY: any; // Vectorize binding (type varies by workers-types version)
  // Issue #2223 (AiSearchAgent): the ai_search_namespaces binding —
  // the agent-tool door onto the Cloudflare AI Search instance.
  // Optional: the binding is NOT declared in wrangler.jsonc in this
  // slice, because its "namespace" value is dashboard-issued (the
  // account's AI Search namespace id) and is not recorded anywhere
  // in this repo; inventing one would bind the wrong namespace.
  // Absence = the namespace path is unconfigured and the agent
  // degrades honestly to the MCP / REST paths. Owner enablement:
  // add the ai_search_namespaces entry (binding "AI_SEARCH",
  // namespace <dashboard value>, remote true) to wrangler.jsonc and
  // set AI_SEARCH_INSTANCE.
  AI_SEARCH?: AiSearchNamespace;
  // Issue #2223 (AiSearchAgent): the instance name the namespace
  // path searches (env.AI_SEARCH.get(AI_SEARCH_INSTANCE)). Additive
  // config — the REST leg keeps using AI_SEARCH_ENDPOINT below,
  // the same var the SearchHub knowledge surface uses.
  AI_SEARCH_INSTANCE?: string;
  // Issue #2223 (AiSearchAgent): the instance's public MCP endpoint
  // URL (…search.ai.cloudflare.com/mcp) for the MCP path. Additive
  // config; the endpoint exists only when the owner enables the
  // instance's Public Endpoint in the Cloudflare dashboard, so
  // absence = the MCP path is unconfigured, never an error.
  AI_SEARCH_MCP_ENDPOINT?: string;
  AI_SEARCH_ENDPOINT: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // #945 Google-as-plugin — Google OAuth client credentials. Optional:
  // Google login only exists as a wired provider, and its adapter
  // fails closed when these are absent. They are owner-set secrets
  // (Cloudflare dashboard or `wrangler secret put`), NEVER committed
  // to the repo or to wrangler.jsonc. Enablement (adding "google" to
  // IAAA_ENABLED_PROVIDERS) is a separate owner step after these exist.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_BASE_URL: string;
  SESSION_SECRET: string;
  // #945 Wiring Phase 1 — config-gated enablement. Both optional; absence
  // means wiring is OFF and the legacy login flow runs unchanged. Rollback
  // is a config change only: unset IAAA_WIRING_ENABLED (or remove a
  // provider from IAAA_ENABLED_PROVIDERS). No code change, no secret.
  // IAAA_WIRING_ENABLED: "1" or "true" (case-insensitive) = on; anything else = off.
  IAAA_WIRING_ENABLED?: string;
  // Issue #2444 — wired session freshness gate (DO request meter).
  // Milliseconds a cached wired session may be served without a fresh
  // store read. Default 30s when unset; "0" disables gating (the
  // rollback lever). SECURITY TRADE-OFF: revocation/step-up
  // propagation is delayed up to the window (CISO domain, #945 open
  // item) — the window value needs owner/CISO sign-off before merge.
  // NOTE: removing this var does NOT disable gating (the code default
  // is 30s); only "0" disables it.
  IAAA_WIRED_FRESHNESS_MS?: string;
  // Issue #2419 — externalized polling cadences (AOP). All optional;
  // absence means the pollingConfig defaults apply. Values are
  // milliseconds, except CHAT_AUTO_REFRESH_FLOOR_S (seconds, matching
  // the stored user interval). Rollback is unsetting the vars (or
  // restoring the defaults) and redeploying — no code change.
  QUOTES_REST_FALLBACK_MS?: string;
  QUOTES_WS_RECONNECT_BASE_MS?: string;
  QUOTES_WS_RECONNECT_CAP_MS?: string;
  OPTIONS_FLOWS_POLL_MS?: string;
  OPTIONS_LATEST_POLL_MS?: string;
  CHAT_AUTO_REFRESH_FLOOR_S?: string;
  GOAL_TRACK_POLL_MS?: string;
  GOAL_TRACK_DEADLINE_MS?: string;
  // Issue #2443 — TickerAgent push cadence, seconds. Optional;
  // absence means the TICKER_PUSH_INTERVAL_SECONDS default (5s)
  // applies. Changing this value changes live tick cadence and is a
  // product call. Rollback is unsetting the var and redeploying.
  TICKER_PUSH_INTERVAL_S?: string;
  // #1169 S2 — flag-gated corpus serving. Same idiom as IAAA above:
  // "1"/"true"/"on" (case-insensitive) = on; absence = OFF (the var is
  // deliberately NOT in wrangler.jsonc — S2 ships default-off).
  // Flag-ON enables the aiSearch mapping fixes, GET /knowledge/file,
  // and result provenance. Rollback is unsetting the var (or "0")
  // and redeploying — no code change. The flag NEVER touches the
  // aiSearch fallback (S3 owns it) or the G1 1.0 scores.
  KNOWLEDGE_SERVING_ENABLED?: string;
  // #2433 (#1976 step 5b) — flag-gated session/identity family
  // ports. Same idiom as KNOWLEDGE_SERVING_ENABLED above:
  // "1"/"true"/"on" (case-insensitive) = on; absence = OFF (the
  // var is deliberately NOT in wrangler.jsonc — the slice ships
  // default-off). Flag-ON composes session records, identity
  // bindings, membership and access requests through
  // src/data/createSessionPorts.ts over the SAME SessionStore
  // DO and kv_store table; flag-OFF is today's funnel,
  // byte-identical. Rollback is unsetting the var — no code
  // change, no data migration.
  SESSION_PORTS_ENABLED?: string;
  // #2246 — flag-gated report indexing into the AI Search instance.
  // Same idiom as KNOWLEDGE_SERVING_ENABLED above: "1"/"true"/"on"
  // (case-insensitive) = on; absence = OFF (the var is deliberately
  // NOT in wrangler.jsonc — the slice ships default-off). Flag-ON
  // makes the canonical report store seams ALSO upload each report
  // to the instance via AiSearchAgent's indexing executor
  // (src/agents/aiSearchPaths.ts), best-effort beside the Vectorize
  // leg. Enablement follows the #1169 probe gate (owner adds the
  // ai_search_namespaces binding + AI_SEARCH_INSTANCE, the probe
  // verifies, then the flag flips). Rollback is unsetting the var —
  // no code change, no data migration.
  AI_SEARCH_REPORT_INDEXING_ENABLED?: string;
  // Comma-separated provider ids. Default when wiring is on: "github".
  // An id with no registered adapter is ignored, never a fallback.
  IAAA_ENABLED_PROVIDERS?: string;
  // #945 Wiring Phase 2b-part1 — tenant for IAAA audit attribution.
  // Optional and owner-set. In Phase 2b-part1, when unset (or blank),
  // the logout audit hook was DORMANT. In the GitHub end-to-end
  // slice, the call sites resolve the tenant as IAAA_TENANT_ID when
  // set, else the documented single-tenant default "primary" (see
  // src/security/iaaaGithubEndToEnd.ts and
  // docs/iaaa-github-end-to-end-defaults.md). A multi-tenant
  // deployment must set this explicitly; "primary" is the
  // single-tenant assumption, not a multi-tenant answer.
  IAAA_TENANT_ID?: string;
  // #945 GitHub end-to-end — PDP route enforcement flag. Optional;
  // "1" or "true" (case-insensitive) = on, anything else (including
  // absence) = off. Default OFF: with no bootstrap list set,
  // turning it on would deny every wired session that holds no
  // membership, including the legitimate owner. Activation = set
  // IAAA_BOOTSTRAP_ADMINS + IAAA_TENANT_ID + this flag, redeploy;
  // rollback = unset this flag, redeploy. No code change.
  IAAA_PDP_ENABLED?: string;
  // #945 Wiring Phase 2b-part2 — bootstrap admin list for membership
  // provisioning. Optional, comma-separated. Each entry is either a
  // bare internal user id (UUID) or a provider subject in
  // issuer:subject form (resolved through the Slice 1 binding).
  // When unset, blank, or empty, ZERO members are provisioned:
  // there is no hardcoded admin, no default user, and no fallback
  // to a GitHub login. Parsed by parseBootstrapAdmins, provisioned
  // only from an admin-only setup path (never from a route or a
  // login path), and granting tenant-admin only — never
  // platform-admin. See src/security/iaaaBootstrap.ts.
  IAAA_BOOTSTRAP_ADMINS?: string;
  // #1185 / #1066 — explicit service identity for unattended work
  // (worker scheduled()/queue() and session-less entry points).
  // Optional, owner-set, and NON-secret: a login id the owner authorizes
  // once through the normal E*TRADE linking flow, so its token is a
  // stored per-identity token in the SessionStore with the same expiry /
  // renewal / revocation lifecycle as any user token. When unset, blank,
  // or not login-shaped there is NO unattended identity: background
  // dispatch fails closed (logged skip), never a hardcoded fallback.
  // Resolved in src/security/serviceIdentity.ts (getServiceUserLogin).
  SERVICE_USER_LOGIN?: string;
  MAS_MAX_STEPS?: string;
  AI_MODEL?: string;
  // #1741 — AI Gateway routing (plain vars, owner-set, non-secret).
  // AI_GATEWAY_ID: Cloudflare AI Gateway id; when set, every model
  // built by getWorkersAIModel routes through it (rate limiting,
  // caching, failover). Unset => direct Workers AI path, unchanged.
  // AI_GATEWAY_CACHE_TTL: gateway cache TTL in seconds (optional).
  // AI_GATEWAY_RATE_LIMIT_RPM: port-level rate limit, req/min (optional).
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_CACHE_TTL?: string;
  AI_GATEWAY_RATE_LIMIT_RPM?: string;
  // #1711 — payments flow switch (ONE switch, non-secret, owner-set).
  // PAYMENTS_FLOW_MODE: "hitl" | "immediate" (case-insensitive, padded
  // values accepted). Default when unset or blank: "hitl" — the #1690
  // HITL-draft behavior. "immediate" restores the pre-#1690 route
  // behavior (checkout at create). Any other value FAILS CLOSED to
  // "hitl" and is logged + audited as payment.config_error by the
  // payments route — never silently treated as immediate. Set via a
  // Worker plain-text var (wrangler.jsonc `vars` or the Cloudflare
  // dashboard Variables) and redeploy; rollback is unsetting the var
  // (or setting it to "hitl") and redeploying — no code change. This
  // slice deliberately does NOT set a production value: production
  // values are an owner action. #1735 re-scopes the RESOLUTION to
  // run > session > user > global env > built-in hitl (the env var
  // stays the global fallback): resolved by
  // resolvePaymentsFlowModeScoped in src/config/paymentsFlowModes.ts
  // via the payments route context; the legacy env-only
  // resolvePaymentsFlowMode in src/agents/routes/payments.ts is kept
  // unchanged. The run value is execution-owner-set, never request
  // input (a caller must not flip their own execution to immediate).
  PAYMENTS_FLOW_MODE?: string;
  // #1721 (parent #1717) — ONE switch per categories / referrals /
  // external-ads pair (non-secret, owner-set, same pattern as
  // PAYMENTS_FLOW_MODE). Values "route" | "mcp" (case-insensitive,
  // padded values accepted). Default when unset or blank: "route" —
  // current public route behavior (notably external ads cpm 15.0 /
  // cpc 1.25). Any other value FAILS CLOSED to "route" and is logged
  // + audited as <domain>.config_error — never silently treated as
  // "mcp". Set via a Worker plain-text var (wrangler.jsonc `vars` or
  // the Cloudflare dashboard Variables) and redeploy; rollback is
  // unsetting the var (or setting it to "route") and redeploying — no
  // code change. This slice deliberately does NOT set a production
  // value: production values are an owner action. Resolution order
  // (run > session > user > global env > built-in) lives in
  // src/config/adsRevenueModes.ts.
  CATEGORIES_MODE?: string;
  REFERRALS_MODE?: string;
  EXTERNAL_ADS_MODE?: string;
  // #1722 (parent #1717, slice (b)) — ONE NLQ port-contract switch
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // Values "rest" | "mcp" (case-insensitive, padded values
  // accepted). Default when unset or blank: "rest" — the REST-sync
  // public route behavior (full port set on the REST route; the
  // async-job contract is the other "public route" spelling and is
  // NOT the default). Any other value FAILS CLOSED to "rest" and is
  // logged + audited as nlq.config_error — never silently treated as
  // "mcp". Set via a Worker plain-text var (wrangler.jsonc `vars` or
  // the Cloudflare dashboard Variables) and redeploy; rollback is
  // unsetting the var (or setting it to "rest") and redeploying — no
  // code change. This slice deliberately does NOT set a production
  // value: production values are an owner action. Resolution order
  // (run > session > user > global env > built-in) and the
  // enforcement exclusions (x-user-login gate, webhook social-port
  // withholding) live in src/config/nlqModes.ts.
  NLQ_MODE?: string;
  // #1723 (parent #1717, slice (c)) — TWO knowledge + memory switches
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // KNOWLEDGE_MODE: "search" | "platform" (case-insensitive, padded
  // values accepted). Built-in default = the calling tool's own
  // legacy contract (knowledge_search → "search",
  // query_platform_knowledge → "platform") — there is no REST search
  // route whose behavior could serve as a single default. Any other
  // value FAILS CLOSED to the calling tool's legacy and is logged +
  // audited as knowledge.config_error — never silently treated as the
  // other contract. Resolution order (run > session > user > global
  // env > built-in) lives in src/config/knowledgeMemoryModes.ts.
  KNOWLEDGE_MODE?: string;
  // MEMORY_READ_MODE: "capped" | "uncapped" (case-insensitive, padded
  // values accepted). Governs the memory READ CAP ONLY (never
  // remember/delete/clear). Built-in default = the calling surface's
  // own legacy cap (REST GET /memory → "capped" at 100 rows; MCP
  // list / memory resource → "uncapped"). Any other value FAILS
  // CLOSED to the surface legacy and is logged + audited as
  // memory.config_error. This slice deliberately does NOT set a
  // production value for either switch: production values are an
  // owner action. Rollback is unsetting the var and redeploying.
  MEMORY_READ_MODE?: string;
  // #1724 (parent #1717, slice (d)) — TWO async-jobs switches
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // HTTP_DELIVERY_MODE: "sync" | "queued" (case-insensitive, padded
  // values accepted). Governs the DO /api queue decision and the MCP
  // tools/call wrapping decision. Built-in default = the calling
  // surface's own legacy: HTTP per-prefix rule (immediate prefixes
  // sync, other /api or async-eligible requests queued), MCP
  // submitter rule (submitter present → queued, absent → sync).
  // Any other value FAILS CLOSED to the surface legacy and is logged
  // + audited as jobs.config_error. Resolution order (run > session
  // > user > global env > built-in) lives in
  // src/config/asyncJobModes.ts.
  HTTP_DELIVERY_MODE?: string;
  // JOB_LIST_ENVELOPE: "count" | "nocount" (case-insensitive, padded
  // values accepted). Governs the LIST envelope only (MCP
  // list_async_jobs and REST GET /jobs). Built-in default = the
  // calling surface's own legacy envelope (MCP → "count", REST →
  // "nocount"). Any other value FAILS CLOSED to the surface legacy
  // and is logged + audited as jobs.config_error. This slice
  // deliberately does NOT set a production value for either switch:
  // production values are an owner action. Rollback is unsetting the
  // var and redeploying.
  JOB_LIST_ENVELOPE?: string;
  // #1725 (parent #1717, slice (e)) — EIGHT quote switches
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // QUOTE_EXPIRY_MODE: "honour" | "continuity" (M2). Built-in
  // defaults are per surface: HTTP/facade → "honour", WS/getBatch
  // → "continuity". QUOTE_STREAM_PROVENANCE: "bare" |
  // "provenance" (M2 WS shape; default WS "bare", HTTP always
  // provenance). QUOTE_HTTP_PROVIDER_MODE: "yahoo-only" | "env"
  // (M2b; default HTTP "yahoo-only", the runtime-confirmed
  // call-site fact; WS always passes env). QUOTE_ALPACA_KEY_MODE:
  // "either" | "id-only" (M6; default hybrid "id-only",
  // marketStream "either"). QUOTE_FALLBACK_MODE: "fallthrough" |
  // "no-substitution" (M3/M9; default marketStream "fallthrough",
  // registry "no-substitution" pinned). QUOTE_ETRADE_UNKNOWN_MODE:
  // "throw" | "zero-object" (M7; default platform "throw",
  // service sync "zero-object"; #922 curated-live throw stands in
  // every mode). QUOTE_YAHOO_OPEN_MODE: "midpoint" | "wire" (M4;
  // default single "midpoint", batch "wire" pinned).
  // QUOTE_YAHOO_INDICATORS_MODE: "computed" | "unset" (M4; default
  // single "computed", batch "unset" pinned). Any other value
  // FAILS CLOSED to the surface legacy and is console-logged as
  // quotes.config_error (quote surfaces are unaudited today, so no
  // audit writer exists on these paths). Resolution order (run >
  // session > user > global env > built-in) lives in
  // src/config/quoteModes.ts. This slice deliberately does NOT set
  // production values: production values are an owner action.
  // Rollback is unsetting the var and redeploying.
  QUOTE_EXPIRY_MODE?: string;
  QUOTE_STREAM_PROVENANCE?: string;
  QUOTE_HTTP_PROVIDER_MODE?: string;
  QUOTE_ALPACA_KEY_MODE?: string;
  QUOTE_FALLBACK_MODE?: string;
  QUOTE_ETRADE_UNKNOWN_MODE?: string;
  QUOTE_YAHOO_OPEN_MODE?: string;
  QUOTE_YAHOO_INDICATORS_MODE?: string;
  // #1726 (parent #1717, slice (f)) — SIX E*TRADE switches
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // ETRADE_SCAN_MODE: "listings" | "screened" (E01). ETRADE_QUOTE_MODE:
  // "mcp" | "rest" (E02). ETRADE_PREVIEW_MODE: "local" | "broker"
  // (E03). ETRADE_POSITIONS_MODE: "mcp" | "rest" (E05).
  // ETRADE_STATUS_MODE: "mcp" | "rest" (E06 status).
  // ETRADE_DISCOVERY_MODE: "mcp" | "rest" (E06 discovery). Built-in
  // defaults are per surface (MCP legacy vs REST legacy), recorded in
  // src/config/etradeModes.ts. Any other value FAILS CLOSED to the
  // surface legacy, console-logged + audited as etrade.config_error.
  // Resolution order (run > session > user > global env > built-in)
  // lives in src/config/etradeModes.ts. This slice deliberately does
  // NOT set production values: production values are an owner action.
  // Rollback is unsetting the var and redeploying. The E04 execute
  // gate is NOT a switch and has no env var.
  ETRADE_SCAN_MODE?: string;
  ETRADE_QUOTE_MODE?: string;
  ETRADE_PREVIEW_MODE?: string;
  ETRADE_POSITIONS_MODE?: string;
  ETRADE_STATUS_MODE?: string;
  ETRADE_DISCOVERY_MODE?: string;
  // #1727 (parent #1717, slice (g)) — SEVEN market-data switches
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // MARKET_DATA_QUOTE_MODE: "mcp" | "rest" (F01). MARKET_DATA_FUNDAMENTALS_MODE:
  // "mcp" | "rest" (F01). MARKET_DATA_RESEARCH_MODE: "mcp" | "rest" (F01;
  // audit-name decision: rest spelling market_data.research_generated is
  // canonical for new consumers, mcp spelling preserved under
  // mode=mcp). MARKET_DATA_BARS_MODE: "mcp" | "rest" (F02).
  // MARKET_DATA_SNAPSHOT_MODE: "mcp" | "rest" (F03).
  // ALPACA_READS_MODE: "mcp" | "rest" | "none" (F04, three-way).
  // ALPACA_ORDER_MODE: "mcp" | "market-data" | "trading" (F05,
  // three-way). Built-in defaults are per surface (MCP legacy vs
  // /market-data legacy vs /trading legacy), recorded in
  // src/config/marketDataModes.ts. Any other value FAILS CLOSED to the
  // surface legacy, console-logged + audited as market_data.config_error.
  // Resolution order (run > session > user > global env > built-in)
  // lives in src/config/marketDataModes.ts. This slice deliberately does
  // NOT set production values: production values are an owner action.
  // Rollback is unsetting the var and redeploying.
  MARKET_DATA_QUOTE_MODE?: string;
  MARKET_DATA_FUNDAMENTALS_MODE?: string;
  MARKET_DATA_RESEARCH_MODE?: string;
  MARKET_DATA_BARS_MODE?: string;
  MARKET_DATA_SNAPSHOT_MODE?: string;
  ALPACA_READS_MODE?: string;
  ALPACA_ORDER_MODE?: string;
  // #1733 (parent #1717, slice (m)) — ONE audit-write switch
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // AUDIT_WRITE_MODE: "legacy" | "strict" (R04). legacy = each
  // audit-write spelling keeps its own contract (POST /audit
  // unvalidated, POST /audit/event strict); strict = POST /audit
  // also applies the /audit/event validation while keeping its own
  // defaults and 200 shape; /audit/event is strict in every mode.
  // Any other value FAILS CLOSED to legacy, console-logged +
  // audited as audit.config_error. Resolution order (run > session
  // > user > global env > built-in) lives in
  // src/config/restTwinsModes.ts. This slice deliberately does NOT
  // set a production value: production values are an owner action.
  // Rollback is unsetting the var and redeploying.
  AUDIT_WRITE_MODE?: string;
  // #1728 (parent #1717, slice (h)) — SIX agentic-payments +
  // premium-gating switches (non-secret, owner-set, same pattern as
  // PAYMENTS_FLOW_MODE). PAYMENTS_CREATE_MODE: "mcp" | "rest" (P-1).
  // PAYMENTS_CONFIRM_MODE: "mcp" | "rest" (P-2 envelope only).
  // PAYMENTS_TRANSACTIONS_MODE: "mcp" | "rest" (P-3).
  // AGENTIC_WALLET_MODE: "mcp" | "rest" (P-5).
  // PREMIUM_SCREENER_MODE: "mcp" | "rest" (P-6a envelope only).
  // PREMIUM_RESEARCH_MODE: "mcp" | "rest" (P-6b envelope only).
  // Built-in defaults are per surface (MCP legacy "mcp", REST legacy
  // "rest"), recorded in src/config/agenticPaymentsModes.ts — unset
  // switches change nothing on either surface. Any other value FAILS
  // CLOSED to the surface legacy, console-logged + audited as
  // payment.config_error (premium routes log only: their context has
  // no audit writer). Resolution order (run > session > user >
  // global env > built-in) lives in
  // src/config/agenticPaymentsModes.ts. This slice deliberately does
  // NOT set production values: production values are an owner action.
  // Rollback is unsetting the var and redeploying. The switches do
  // NOT govern: the route gateway 400, HITL, PAYMENTS_FLOW_MODE, the
  // P-2 facade success-flag gap (follow-up), premium verification /
  // prices / channels / identity / capture, or any single-surface
  // route (capture, webhook, dids, agentic ledger, stock-signals).
  PAYMENTS_CREATE_MODE?: string;
  PAYMENTS_CONFIRM_MODE?: string;
  PAYMENTS_TRANSACTIONS_MODE?: string;
  AGENTIC_WALLET_MODE?: string;
  PREMIUM_SCREENER_MODE?: string;
  PREMIUM_RESEARCH_MODE?: string;
  // #1729 (parent #1717, slice (i)) — ONE goal-chain switch
  // (non-secret, owner-set, same pattern as PAYMENTS_FLOW_MODE).
  // GOAL_COMPILE_MODE: "auto" | "fresh" (G01 goal.compile).
  // Built-in default is "auto" (the MCP surface's current
  // behavior: bindings present → prior-plan reuse with
  // provenance, else fresh compile), recorded in
  // src/config/goalChainModes.ts — unset changes nothing.
  // Any other value FAILS CLOSED to "auto", console-logged +
  // audited as goal.config_error. Resolution order (run >
  // session > user > global env > built-in) lives in
  // src/config/goalChainModes.ts. This slice deliberately does
  // NOT set a production value: production values are an owner
  // action. Rollback is unsetting the var and redeploying.
  // The switch does NOT govern: goal.schedule's PENDING-only
  // posture, chain.run's inline-only posture, AgentDB tenant
  // sourcing, or any AgentDB read source — all pinned, see
  // src/config/goalChainModes.ts.
  GOAL_COMPILE_MODE?: string;
  // Payment Gateway Secrets (Stripe, PayPal, Lemon Squeezy)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_ENVIRONMENT?: "sandbox" | "live";
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  // External Payment Service MCP Server Endpoints (Remote MCP over JSON-RPC 2.0 / SSE)
  STRIPE_MCP_SERVER_URL?: string;
  PAYPAL_MCP_SERVER_URL?: string;
  LEMONSQUEEZY_MCP_SERVER_URL?: string;
  EXTERNAL_PAYMENTS_MCP_URL?: string;
  // Externalized Environment Configuration (TEST / PROD)
  APP_ENV?: string;
  ENVIRONMENT?: string;
  // E*TRADE Trading API & Remote MCP Configuration
  ET_API_KEY?: string;
  ET_API_SECRET?: string;
  ET_PROD_API_KEY?: string;
  ET_PROD_API_SECRET?: string;
  ET_SANDBOX_API_KEY?: string;
  ET_SANDBOX_API_SECRET?: string;
  ET_BASE_URL?: string;
  ETRADE_CONSUMER_KEY?: string;
  ETRADE_CONSUMER_SECRET?: string;
  // #1185 Phase B (#1066): ETRADE_OAUTH_TOKEN(_SECRET) removed — the
  // process-wide static pair is deleted and the vars are unread. Access
  // tokens are per-user, stored in the SessionStore.
  ETRADE_ACCOUNT_ID_KEY?: string;
  ETRADE_ENVIRONMENT?: "sandbox" | "live";
  ETRADE_MCP_SERVER_URL?: string;
  ETAPI_CONFIG?: string;
  // Market Data & Research Configuration (yfinance & Alpaca)
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_BASE_URL?: string;
  ALPACA_DATA_URL?: string;
  YFINANCE_API_ENDPOINT?: string;
  MARKET_DATA_PROVIDER?: "alpaca" | "yfinance" | "hybrid";
  // Cloudflare Email Service & Email Agent Configuration
  EMAIL?: any;
  EMAIL_SECRET?: string;
  EMAIL_AGENT_ADDRESS?: string;
  // Cloudflare Slack Agent Configuration
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  // Cloudflare Voice Agent Configuration
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  VOICE_AGENT_MODEL?: string;
  // Cloudflare Agentic Payments (x402 & Machine Payments Protocol - MPP)
  X402_NETWORK?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_FACILITATOR_URL?: string;
  X402_AUTO_APPROVE_LIMIT?: string;
  X402_AGENT_WALLET_KEY?: string;
  MPP_SECRET_KEY?: string;
  // Cloudflare Wallets — native paidTool / withX402 binding for OptionsScannerMCP
  // https://blog.cloudflare.com/wallets/
  CF_WALLET_RECIPIENT?: string;    // 0x... USDC recipient address
  CF_WALLET_NETWORK?: string;      // "base-sepolia" (test) | "base" (prod)
  CF_WALLET_FACILITATOR?: string;  // https://x402.org/facilitator (default)
  // Cloudflare Browser Rendering & Puppeteer
  BROWSER?: Fetcher;
  // Webhooks Configuration (TradingView, E*TRADE Alerts, Outbound)
  TRADINGVIEW_WEBHOOK_SECRET?: string;
  ETRADE_WEBHOOK_SECRET?: string;
  OUTBOUND_WEBHOOK_URL?: string;
  OUTBOUND_WEBHOOK_SECRET?: string;
  INBOUND_NLQ_WEBHOOK_SECRET?: string;
  // Optional comma-separated domain allowlist for outbound email recipients
  // (emailTo) on webhook-triggered email paths. When set, only addresses
  // whose domain is listed are accepted. When unset, only format validation
  // applies (a warning is logged on first use). Issue #143 P0.
  EMAIL_TO_ALLOWED_DOMAINS?: string;
  // Issue #1262 Phase 1: inbound email trading principal map. JSON object:
  // lowercased sender address → { "login": "<cfagent login>", "tier":
  // "read" | "preview" | "trade" }. Plain configuration (like
  // EMAIL_TO_ALLOWED_DOMAINS), NOT a credential. Unmapped senders are
  // refused; trade tier additionally requires a DKIM/SPF pass on the
  // message. Parsed by parseEmailPrincipals (src/trading/channels/intake).
  CHANNEL_EMAIL_PRINCIPALS?: string;
  // Nightly mas_messages retention window in days (issue #255, part of
  // #143). Default 90. A value <= 0 disables the retention pass entirely.
  MAS_MESSAGES_RETENTION_DAYS?: string;
  // Nightly mas_events retention window in days (issue #786). Default
  // 365. A value <= 0 disables only the mas_events prune.
  MAS_EVENTS_RETENTION_DAYS?: string;
  /** #2294: age window for mas_job_outcomes (default 90 days; <= 0 disables). */
  MAS_JOB_OUTCOMES_RETENTION_DAYS?: string;
  // Nightly mas_memory retention window in days, by updated_at (issue
  // #786). Default 365. A value <= 0 disables only the mas_memory prune.
  MAS_MEMORY_RETENTION_DAYS?: string;
  // Cloudflare Vectorize & AI Search
  VECTORIZE?: any;
  // Optional / backward-compatible bindings
  KV?: KVNamespace;
  BROWSER_AGENT?: DurableObjectNamespace;
  SLACK_AGENT?: DurableObjectNamespace;
  // Issue #2253 — SandboxAgent DO (fleet registration; no production
  // caller yet — bindings first, the #2215 posture).
  SANDBOX_AGENT?: DurableObjectNamespace;
  TASKS_AGENT?: DurableObjectNamespace;
  MEMORY_AGENT?: DurableObjectNamespace;
  RESEARCH_AGENT?: DurableObjectNamespace;
  REPORT_ASSET_AGENT?: DurableObjectNamespace;
  TRADING_AGENT?: DurableObjectNamespace;
  /** Bearer token required on A2A dispatch POSTs (#291 A5). Unset = dispatch disabled (fail closed). Since S16 (#2426) this is the TRANSITIONAL shared fallback: it authenticates only surfaces whose per-agent credential (below) is unset, and is removed once every surface carries its own. */
  A2A_API_TOKEN?: string;
  // Per-agent A2A mesh credentials (S16, #2426): one optional Worker
  // secret per A2A surface, verified at the edge by
  // src/a2a/meshCredentials.ts. A surface whose secret is set accepts
  // ONLY that credential; a surface without one falls back to the
  // shared A2A_API_TOKEN transitionally. Owner-set in production;
  // never a value in code or config files.
  A2A_TOKEN_ORCHESTRATOR?: string;
  A2A_TOKEN_SEARCH?: string;
  A2A_TOKEN_TASKS?: string;
  A2A_TOKEN_MEMORY?: string;
  A2A_TOKEN_NLQ?: string;
  A2A_TOKEN_PAYMENTS?: string;
  A2A_TOKEN_TRADING?: string;
  A2A_TOKEN_AISEARCH?: string;
  A2A_TOKEN_SCREENER?: string;
  A2A_TOKEN_SCHEDULED?: string;
  A2A_TOKEN_RESEARCH?: string;
  A2A_TOKEN_REPORT_ASSET?: string;
  A2A_TOKEN_BROWSER?: string;
  A2A_TOKEN_SLACK?: string;
  A2A_TOKEN_SANDBOX?: string;
  /** HMAC key for keyed DID attestation (S16, #2426): a Worker secret the owner sets. When set, attestation call sites that thread it produce real HMAC-SHA256 proofs that verifyDidAttestation can verify; unset (or unthreaded), proofs are honestly labelled unkeyed content labels. Never a value in code or config files. */
  DID_ATTESTATION_KEY?: string;
  /** Dedicated Bearer token for POST /api/qa/investigate when no app session exists (#1754). Unset = the service-token path denies (fail closed); the session path is unaffected. Deliberately distinct from A2A_API_TOKEN. */
  QA_INVESTIGATE_TOKEN?: string;
  /** Trade approval workflow binding (#291 T3b). */
  TRADE_WORKFLOW?: Workflow;
  /** Screener screen workflow binding (#1737). */
  SCREENER_WORKFLOW?: Workflow;
  /** Payment workflow binding (#2014). */
  PAYMENT_WORKFLOW?: Workflow;
  /** Cross-domain saga workflow binding (#2041 S1). */
  SAGA_WORKFLOW?: Workflow;
}

export interface TransactionRecord {
  id: string;
  sessionId: string;
  /** "credit" is a one-time replacement-run credit (#2019): value granted
      for a failed paid run, never a cash refund. */
  action: "charge" | "refund" | "invoice" | "payout" | "micropayment" | "agentic_payment" | "credit";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox" | "x402" | "mpp";
  gatewayRef?: string;
  /** "simulated" marks local records of simulated agentic payments — no real payment occurred (issue #122). */
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected" | "simulated";
  checkoutUrl?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  githubLogin: string;
  githubAvatar: string;
  githubName: string;
  createdAt: number;
  /**
   * First creation time, preserved across sliding renewals; the session's
   * hard 30-day lifetime cap is measured from here. Absent on legacy
   * sessions, where createdAt is the first creation time.
   */
  firstCreatedAt?: number;
  // #945 Wiring Phase 1 — optional extensions, added only when IAAA wiring
  // is on. Old sessions without them keep working exactly as before.
  // internalUserId is the stable Slice 1 identity, never derived from a
  // login or email; providerSubject is the provider-stable subject
  // (GitHub numeric user id), not the login.
  internalUserId?: string;
  providerIssuer?: string;
  providerSubject?: string;
  /** Login (authentication) time in ms since epoch, for step-up freshness. */
  authTimeMs?: number;
  /**
   * #945 Wiring Phase 2a — last recorded activity in ms since epoch.
   * Set at wired login and advanced by touchSession (at most once
   * per 60s, so ±60s precision). Sessions without this field
   * (legacy sessions, Phase 1 sessions) are exempt from idle
   * expiry in getValidatedSession — see its header note.
   */
  lastActivityMs?: number;
  /** Session record version; 1 for sessions created by the wired flow. */
  sessionVersion?: number;
}

export type AgentName = "search" | "payments" | "tasks" | "memory" | "general" | "trading" | "research" | "browser" | "sandbox" | "think" | "webhook" | "broker_webhook" | "durable_execution";

export interface AuditEvent {
  id: string;
  sessionId: string;
  type: string;
  agent: AgentName | "judge" | "nlq" | "orchestrator";
  payload: Record<string, unknown>;
  createdAt: string;
  /** Issue #2178 (Q7 S1): hash-chain link; absent/null on pre-chain rows. */
  previousEventHash?: string | null;
  /** Issue #2178 (Q7 S1): own hash; absent on pre-chain rows. */
  eventHash?: string;
}

/**
 * Durable record of a claimed inbound webhook nonce, used for replay
 * protection (issue #143 P0). A nonce is provider-derived: a semantic
 * event identity when the provider supplies one (e.g. E*TRADE
 * orderId:eventType:timestamp), otherwise a SHA-256 hash over
 * (provider, signature, raw body). Stored in the `webhook_replay_nonces`
 * table; entries expire after WEBHOOK_REPLAY_TTL_MS (24h).
 */
export interface WebhookReplayNonce {
  nonce: string;
  source: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Durable record of a report generated by a scheduled run, so the AI
 * Search agent can surface it later (issue #278, owner scope addition
 * 2026-10-18). Stored in the `mas_reports` table; `body` is the full
 * report payload serialized to JSON (capped by the writer).
 */
export interface ScheduledReportRecord {
  id: string;
  runId: string;
  /** Issue #308: idempotency key for the single generate→store seam. */
  generationId?: string;
  title: string;
  source: string;
  summary: string;
  body: string;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent: AgentName | "orchestrator";
  createdAt: string;
}

export interface MemoryRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RouteDecision {
  agent: AgentName;
  confidence: number;
  reason: string;
  needsConfirmation: boolean;
}

export interface QualityDecision {
  score: number;
  grounded: boolean;
  safe: boolean;
  issues: string[];
}

export interface ReferralRecord {
  id: string;
  userLogin: string;
  title: string;
  url: string;
  category: string;
  rewardText: string;
  clicks: number;
  signups: number;
  createdAt: string;
}

export interface AdRecord {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge: string;
  url: string;
  ctaText: string;
  accentColor: string;
  impressions: number;
  clicks: number;
  createdAt: string;
}

export interface CategoryRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAdRecord {
  id: string;
  name: string;
  network: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  placement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  title: string;
  tagline: string;
  ctaText: string;
  targetUrl: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
  createdAt: string;
}

export interface RevenueSummary {
  grossRevenue: number;
  adNetworkRevenue: number;
  marketplaceRevenue: number;
  paymentPlatformFees: number;
  referralPayouts: number;
  netRevenue: number;
  totalImpressions: number;
  totalAdClicks: number;
  averageRPM: number;
}

// ==========================================
// E*TRADE Trading & Screening Domain Models
// ==========================================

export interface TradeRecord {
  id: string;
  sessionId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  price: number;
  totalValue: number;
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled" | "expired";
  orderRef?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  previewNotes?: string;
  expirationScheduleId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ETradeQuote {
  symbol: string;
  companyName: string;
  lastPrice: number;
  price?: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  volume: number;
  averageVolume?: number;
  open: number;
  high: number;
  low: number;
  previousClose?: number;
  peRatio?: number;
  marketCap?: number;
  week52High?: number;
  week52Low?: number;
  high52?: number;
  low52?: number;
  rsi?: number;
  /** Issue #1007: MACD signal as a DATA field from a history-capable
   *  provider (Yahoo adapter). Snapshot providers leave it unset and
   *  the pipeline labels MACD unavailable, as before. */
  macdSignal?: string;
  sector?: string;
  listingExchange?: string;
  source?: string;
  quoteStatus?: string;
  dateTime?: string;
  timestamp: string;
  /** Issue #1133: the parsed wire payload this quote was normalized
   * from — present ONLY when a caller explicitly requests the REST
   * client's includeRawResponse hook (fetchQuoteDetailed) and the
   * service forwards the request (getQuoteAsync / fetchQuoteRemote).
   * Never set on the default path; the one consumer that requests it
   * (the data-provider platform's capture, epic #1116) strips it
   * before the quote travels further. Mirrors ETradeOptionChain.raw. */
  raw?: Record<string, unknown>;
}

/** Issue #1654 slice 5: HH/HL price-action regime — "UP" = higher highs
 *  + higher lows, "DN" = lower highs + lower lows, "RNG" = mixed
 *  (screener-rules.md; fit-gap Gap 4). Produced by classifyPriceRegime()
 *  in src/trading/technicals.ts; slice 6's bias vote reads this value. */
export type PriceRegime = "UP" | "DN" | "RNG";

/** Issue #1654 slice 6: 6-vote composite bias label (see screeningIndicators). */
export type CompositeBias = "Bullish" | "Bearish" | "Neutral";

export interface StockScreenerFilter {
  sector?: string;
  minPrice?: number;
  maxPrice?: number;
  exchange?: "ALL" | "NASDAQ" | "NYSE" | "AMEX";
  minMarketCap?: number; // in billions or absolute
  maxPeRatio?: number;
  maxRsi?: number;
  minRsi?: number;
  /** Issue #1654 slice 1: Bollinger %B extension gate. When either bound
   *  is set, %B gating is active; the overextension cap defaults to 1.0
   *  (doc Extension Gate %B ∈ [0.0, 1.0]) when maxPercentB is unset. */
  maxPercentB?: number;
  minPercentB?: number;
  /** Issue #1654 slice 1: reject candidates whose bandwidth is not at
   *  its lookback minimum (see bollingerBandwidthMin). */
  requireSqueezeGate?: boolean;
  /** Issue #1654 slice 2: reject candidates whose spot price is below
   *  the anchored VWAP (see anchoredVwap). */
  requireAboveAnchoredVwap?: boolean;
  /** Issue #1654 slice 3: ATR% volatility gate (doc range [1.0, 8.0]).
   *  When either bound is set, ATR% gating is active; the unset bound
   *  defaults to the doc bound (min 1.0, max 8.0) — mirroring slice 1's
   *  %B defaulting. Bounds are inclusive. */
  minAtrPct?: number;
  maxAtrPct?: number;
  /** Issue #1654 slice 5: reject candidates whose attached price-action
   *  regime (see regime) does not match. */
  regimeFilter?: PriceRegime;
  /** Issue #1654 slice 6: reject candidates whose attached composite
   *  bias score (see compositeBiasScore) is below this minimum. */
  minCompositeBiasScore?: number;
  gainersOnly?: boolean;
  losersOnly?: boolean;
  rsiFilter?: "oversold" | "overbought" | "neutral" | "any";
  momentum?: "bullish_breakout" | "bearish_pullback" | "high_relative_volume" | "any";
  gainersLosers?: "gainers" | "losers" | "active" | "all" | "movers";
  minVolume?: number;
  search?: string;
  limit?: number;
}

export interface StockScreenRejection {
  symbol: string;
  reason: string;
  changePercent?: number;
  price?: number;
  rsi?: number;
}

export interface StockScreenLedger {
  universeSymbols: string[];
  totalEvaluated: number;
  passedCount: number;
  rejectedCount: number;
  rejections: StockScreenRejection[];
}

/**
 * Issue #1998 (Phase 3): the persisted-gather summary a stock screen
 * carries when its technical fields came from stored gather rows
 * rather than the listing feed. Optional by construction — screens
 * without a gather hook never set it.
 */
export interface StockScreenGatherSummary {
  /** Caller run id the gather rows are keyed by (D2: the idempotency key). */
  runId: string;
  /** Symbols with a valid stored gather row read back. */
  stored: number;
  /** Acquired symbols with no valid stored gather row. */
  missing: number;
  /**
   * Stored-row symbols excluded from evaluation because the row
   * lacks a field this filter needs (honest missing-data
   * rejection, not a market-fact rejection).
   */
  excluded: number;
  /** Stored rows served by the gap-fill provider. */
  gapFilled: number;
  /** Content hash of the capability-route snapshot at run time. */
  routeVersionHash: string;
  /**
   * Issue #1999: first-class gather failure state. "ok" when the
   * gather ran (even when nothing was evaluable); "failed" when the
   * hook itself failed — distinct from missing fields, which stay
   * honest missing-data rejections, never a gather failure.
   */
  status: "ok" | "failed";
  /** Failure reason when status is "failed". */
  error?: string;
}

export interface ScreenedStockItem extends ETradeQuote {
  price: number;
  rsi14?: number;
  /** Issue #1654 slice 1: Bollinger %B from real bar history, attached
   *  upstream where bars exist. Absent = band data unavailable — gates
   *  that need it fail closed, never estimated. */
  percentB?: number;
  /** Current Bollinger bandwidth (Upper − Lower) / Middle. */
  bollingerBandwidth?: number;
  /** Minimum bandwidth over the lookback window (125 days when history
   *  allows; fewer when history is short — see bollingerBarsUsed). */
  bollingerBandwidthMin?: number;
  /** Closes the attached band values were computed from. The squeeze
   *  gate requires ≥ 21 (default 20-period bands + 1 prior bandwidth
   *  point); fewer bars cannot support a non-trivial minimum. */
  bollingerBarsUsed?: number;
  /** Issue #1654 slice 2: anchored VWAP from the 52-week low bar,
   *  attached upstream where real bar history exists. Absent = AVWAP
   *  data unavailable — the gate that needs it fail-closes, never
   *  estimated. */
  anchoredVwap?: number;
  /** Issue #1654 slice 3: ATR% = ATR₁₄ / last close × 100, attached
   *  upstream where real bar history exists (see computeAtr). Absent
   *  = ATR data unavailable — the gate that needs it fail-closes,
   *  never estimated. No separate `atr` field: the gate reads only
   *  this percentage, so a raw-ATR field would be speculative. */
  atrPct?: number;
  /** Issue #1654 slice 5: HH/HL price-action regime from real bar
   *  history, attached upstream where bars exist. Absent = regime
   *  data unavailable — the filter that needs it fail-closes, never
   *  estimated. */
  regime?: PriceRegime;
  /** Issue #1654 slice 6: 6-vote composite bias score (bullish-vote
   *  count, 0–6) from real bar history, attached upstream where bars
   *  exist. Absent = bias data unavailable — the gate that needs it
   *  fail-closes, never estimated. */
  compositeBiasScore?: number;
  /** Issue #1654 slice 6: 6-vote composite bias label for the attached
   *  score (see compositeBiasScore). */
  compositeBias?: CompositeBias;
  macdSignal: string;
  signal: "BULLISH_MOMENTUM" | "OVERSOLD_BOUNCE" | "RANGE_BOUND" | "OVERBOUGHT";
  technicalSignal: string;
  momentumScore: number;
  highlightReason: string;
  previousClose?: number;
  changePeriod?: string;
  rsiLookback?: string;
  macdIndicatorVersion?: string;
  validationStatus?: "PASS_CONFIRMED" | "FAIL_MISMATCH" | "UNVERIFIED";
}

export interface StockScreenResult {
  totalScanned: number;
  totalScreened: number;
  matchedCount: number;
  filterApplied: StockScreenerFilter;
  filterSummary: string;
  stocks: ScreenedStockItem[];
  scannedAt: string;
  status?: "matches_found" | "no_matches" | "SCAN_INVALID_DATA_MISMATCH" | "no_universe";
  ledger?: StockScreenLedger;
  validationError?: string;
  /** Issue #1998: present only when a gather hook enriched this screen. */
  gather?: StockScreenGatherSummary;
  discovery?: {
    mode: "all_us_listings";
    candidateCount: number;
    listingCount: number;
    sourceCounts: Record<string, number>;
    message: string;
    error?: string;
  };
  movers?: {
    gainers: ScreenedStockItem[];
    losers: ScreenedStockItem[];
  };
}

// =========================================================================
// Dynamic Options Screener Engine Types
// =========================================================================

export type OptionScreenSortKey =
  | "volume" // highest volume first (default)
  | "spreadPct" // tightest spread first (ascending)
  | "iv" // highest implied volatility first
  | "volumeOiRatio" // highest Vol/OI (unusual activity) first
  | "dte" // nearest expiration first (ascending)
  | "strikeDistance"; // closest to the money first (ascending)

export interface OptionScreenerFilter {
  /** Explicit underlyings to screen; normalized (uppercased/deduped) and capped at MAX_SCAN_SYMBOLS. */
  underlyingSymbols?: string[];
  /** Cap on dynamically discovered underlyings (1..MAX_SCAN_SYMBOLS). Required when underlyingSymbols is absent. */
  maxUnderlyings?: number;
  /** Not supported by the all-listings discovery feed; rejected with a validationError unless "all"/"any". */
  sector?: string;
  contractType?: "CALL" | "PUT" | "BOTH";
  minVolume?: number;
  minOpenInterest?: number;
  /** Maximum bid/ask spread as a percent of the midpoint. */
  maxSpreadPct?: number;
  /** Quote-age reference in seconds used for FRESH/STALE labeling; stale rows are labeled, never discarded. */
  maxQuoteAgeSeconds?: number;
  /** Minimum delta compared against the ABSOLUTE delta (0..1); returned contracts keep their signed delta. */
  minDelta?: number;
  /** Maximum delta compared against the ABSOLUTE delta (0..1). */
  maxDelta?: number;
  minGamma?: number;
  maxGamma?: number;
  minTheta?: number;
  maxTheta?: number;
  /** Minimum vega. */
  minVega?: number;
  /** Maximum vega. */
  maxVega?: number;
  /** Minimum rho. */
  minRho?: number;
  /** Maximum rho. */
  maxRho?: number;
  /** Minimum option premium in USD, evaluated on the bid/ask midpoint. */
  minPrice?: number;
  /** Maximum option premium in USD, evaluated on the bid/ask midpoint. */
  maxPrice?: number;
  minImpliedVolatility?: number; // decimal e.g. 0.35 = 35%
  maxImpliedVolatility?: number; // decimal e.g. 1.20 = 120%
  minDte?: number; // Days to expiration min
  maxDte?: number; // Days to expiration max
  /** Optional bounded expiry bands for strategy discovery. Each band selects its earliest expirations. */
  expirationDteBands?: Array<{ minDte: number; maxDte: number; maxExpirations?: number }>;
  moneyness?: "ITM" | "OTM" | "ATM" | "ALL";
  maxStrikeDistancePct?: number; // e.g. 10 for strikes within 10% of underlying price
  /** Maximum contracts returned (clamped to MAX_RETURNED_CONTRACTS); use totalMatches for the pre-limit count. */
  limit?: number;
  /** Result ordering; defaults to "volume" (highest volume first). */
  sortBy?: OptionScreenSortKey;
}

export interface ScreenedOptionContractItem extends ETradeOptionChainContract {
  underlyingSymbol: string;
  underlyingPrice: number;
  daysToExpiration: number;
  expirationDate: string; // YYYY-MM-DD
  moneyness: "ITM" | "OTM" | "ATM";
  strikeDistancePct: number;
  spreadPct: number;
  quoteAgeSeconds?: number;
  quoteTimestamp?: string;
  quoteFreshness?: "FRESH" | "STALE" | "UNKNOWN";
  volumeOiRatio?: number;
  technicalSignal: string;
  highlightReason: string;
}

/** Machine-readable reason a contract failed screening. */
export type OptionScreenRejectionCode =
  | "ADJUSTED_CONTRACT"
  | "INVALID_QUOTE"
  | "SPREAD_TOO_WIDE"
  | "PREMIUM_OUT_OF_RANGE"
  | "DTE_OUT_OF_RANGE"
  | "DELTA_OUT_OF_RANGE"
  | "GAMMA_OUT_OF_RANGE"
  | "THETA_OUT_OF_RANGE"
  | "VEGA_OUT_OF_RANGE"
  | "RHO_OUT_OF_RANGE"
  | "IV_OUT_OF_RANGE"
  | "VOLUME_TOO_LOW"
  | "OPEN_INTEREST_TOO_LOW"
  | "MONEYNESS_MISMATCH"
  | "STRIKE_DISTANCE_TOO_WIDE";

export interface OptionScreenRejection {
  code: OptionScreenRejectionCode;
  contractSymbol: string;
  underlyingSymbol: string;
  reason: string;
  strikePrice?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  iv?: number;
  volume?: number;
  daysToExpiration?: number;
  spreadPct?: number;
  quoteAgeSeconds?: number;
}

/** A per-symbol upstream fetch failure (auth, network, rate limit, empty payload). */
export interface OptionScreenFetchError {
  symbol: string;
  reason: string;
}

export interface OptionScreenResult {
  totalUnderlyingsScanned: number;
  totalContractsEvaluated: number;
  /** Contracts returned in this payload (after `limit`). */
  matchedCount: number;
  /** Total contracts that matched the filter before `limit` truncation. */
  totalMatches?: number;
  /** Total contracts rejected across all filters (rejections[] holds at most 50 samples). */
  rejectionCount?: number;
  filterApplied: OptionScreenerFilter;
  filterSummary: string;
  contracts: ScreenedOptionContractItem[];
  scannedAt: string;
  /** Provenance of the contracts (issue #65): "live" broker data, or
   *  "calibrated-demo" generated chains served only in demo mode. */
  dataSource?: "live" | "calibrated-demo";
  quoteQuality?: {
    maxAgeSeconds?: number;
    /** Age threshold (seconds) used for FRESH/STALE labels; equals maxAgeSeconds when set, else the default reference. */
    referenceAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  /** "error" when inputs are invalid (see validationError) or nothing could be fetched (see fetchErrors). */
  status: "matches_found" | "no_matches" | "error";
  validationError?: string;
  /** Per-symbol upstream failures; present alongside any status when live fetches failed. */
  fetchErrors?: OptionScreenFetchError[];
  /** Non-fatal notices: clamped inputs, default DTE window, truncation, skipped expirations. */
  warnings?: string[];
  rejections?: OptionScreenRejection[];
  /** Per-underlying put/call ratio and anomaly signal. */
  putCallRatios?: Record<string, { putCallRatio: number; signal: string }>;
}

// =========================================================================
// E*TRADE Watchlist Models & Persistence Types
// =========================================================================

export interface ETradeWatchlistItem {
  symbol: string;
  ordered?: number;
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  companyName?: string;
  sector?: string;
  addedAt?: string;
}

export interface ETradeWatchlist {
  watchlistId: string | number;
  name: string;
  symbols: string[];
  items?: ETradeWatchlistItem[];
  createdTimestamp?: number;
  updatedTimestamp?: number;
  source?: "etrade_api" | "local_durable_sqlite";
}

export interface SaveWatchlistResult {
  success: boolean;
  watchlistId: string | number;
  name: string;
  symbolCount: number;
  symbols: string[];
  source: "etrade_api" | "local_durable_sqlite";
  message: string;
  timestamp: string;
}

export interface WatchlistRecord {
  id: string;
  name: string;
  userLogin: string;
  symbolsJson: string; // JSON string array of ticker symbols
  itemsJson?: string; // Optional detailed cached quote metadata
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface OptionsChainCacheRecord {
  id: string; // symbol e.g. NVDA
  symbol: string;
  expirationsJson: string; // JSON string of ETradeOptionExpireDate[]
  chainsJson: string; // JSON string of ETradeOptionChain[]
  fetchedAt: number; // timestamp in ms
  expiresAt: number; // timestamp in ms
  contractCount: number;
}

export interface ETradeOrderDraft {
  orderId: string;
  previewId?: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  brokerOrderType?: "EQ" | "OPTN" | "SPREADS" | "BUY_WRITES";
  optionLegs?: Array<{
    underlyingSymbol: string;
    securityType: "EQ" | "OPTN";
    side: "BUY" | "SELL";
    quantity: number;
    optionType?: "CALL" | "PUT";
    strike?: number;
    expirationDate?: string;
  }>;
  strategyNetDebit?: number;
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  estimatedPrice: number;
  limitPrice?: number;
  stopPrice?: number;
  term: "GOOD_FOR_DAY" | "GOOD_UNTIL_CANCEL";
  estimatedCommission: number;
  estimatedTotal: number;
  /** Issue #118: quoteStatus of the quote this preview was priced from (e.g. "REALTIME", "STATIC_FALLBACK"). */
  pricingQuoteStatus?: string;
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled" | "expired";
  proposerDid: string;
  authorizerDid: string;
  proofSignature: string;
  previewMessage: string;
  previewNotes?: string;
  safetyNotice?: string;
  expirationScheduleId?: string;
  expiresAt?: string;
  placedAt?: string;
}

export interface ETradeOrderExecutionResult {
  success: boolean;
  orderId: string;
  executionId: string;
  brokerOrderRef: string;
  authorizerDid?: string;
  status: "executed" | "submitted" | "rejected" | "failed";
  symbol: string;
  action: string;
  quantity: number;
  executionPrice: number;
  totalSettled: number;
  didAttestation?: {
    proposerDid: string;
    authorizerDid: string;
    signature: string;
  };
  message: string;
  timestamp: string;
}

export interface ETradePosition {
  symbol: string;
  description: string;
  quantity: number;
  /** Broker product fields, when the source payload carries them (issue #34).
   * securityType is the broker's code (e.g. "EQ", "OPTN"); option fields are
   * populated only for option positions whose contract detail was reported. */
  securityType?: string;
  positionType?: "LONG" | "SHORT";
  optionType?: "CALL" | "PUT";
  strikePrice?: number;
  /** ISO date (yyyy-mm-dd) of option expiry, when applicable. */
  expirationDate?: string;
  pricePaid: number;
  costBasis: number;
  currentPrice: number;
  marketPrice: number;
  marketValue: number;
  totalGain: number;
  unrealizedGainLoss: number;
  totalGainPercent: number;
  unrealizedGainLossPercent: number;
  daysGain: number;
  daysGainPercent: number;
}

export interface ETradeAccount {
  accountId: string;
  accountKey: string;
  accountIdKey?: string;
  accountDesc: string;
  accountName?: string;
  accountType: string;
  accountMode?: string;
  accountStatus?: string;
  institutionType?: string;
  shareWorksAccount?: boolean;
  fcCheckMkt?: boolean;
  lineOfCredit?: boolean;
  openDate?: number;
  closedDate?: number;
  netAccountValue: number;
  totalAccountValue: number;
  cashAvailableForInvestment: number;
  marginBuyingPower?: number;
  dayTraderStatus: boolean;
}

export interface ETradePositionLot {
  positionId?: number | string;
  positionLotId?: number | string;
  price?: number;
  termCode?: number;
  daysGain?: number;
  daysGainPct?: number;
  marketValue?: number;
  totalCost?: number;
  totalCostForGainPct?: number;
  totalGain?: number;
  totalGainPct?: number;
  lotSourceCode?: number;
  originalQty?: number;
  remainingQty?: number;
  availableQty?: number;
  orderNo?: number;
  legNo?: number;
  acquiredDate?: number;
  locationCode?: number;
  exchangeRate?: number;
  settlementCurrency?: string;
  paymentCurrency?: string;
  adjPrice?: number;
  commPerShare?: number;
  feesPerShare?: number;
  adjustedPrice?: number;
}

export interface ETradeBrokerStatus {
  broker: "etrade" | "alpaca";
  name: string;
  configured: boolean;
  mode: "live_oauth" | "sandbox_api" | "mcp_remote" | "simulated_engine";
  protocol: "mcp_json_rpc" | "etrade_oauth_rest" | "sandbox_simulated";
  mcpServerUrl?: string;
  environment: "sandbox" | "live";
  activeEnvironment?: "TEST" | "PROD" | string;
  apiUrl?: string;
  hasApiKey?: boolean;
  oauthAuthenticated?: boolean;
  oauthExpiresAtEt?: string;
  oauthRenewable?: boolean;
  capabilities: string[];
}

/**
 * Data provenance for every market-data object (issue #117, audit #115
 * findings F10/F11; live-only since #923). The market-data providers serve live
 * data or throw explicit unavailable — the non-live values below are the
 * historical labels, retained so a stale object is never misread as live:
 * - "live": actually fetched from the named provider in this call.
 * - "static": served from the bundled MARKET_DATA_RESEARCH_UNIVERSE table.
 * - "generated": deterministically invented (hash-generated profile for an
 *   unlisted ticker, the synthetic bars generator, formula analyst targets).
 * Mirrors the betaService/correlationService labelling standard: every
 * resolution carries its source; values are labelled, never silently
 * invented. A non-live object may keep a `timestamp` for shape compatibility,
 * but it is the object's production time — `provenance` (and `note`, when
 * present) states what the data actually is.
 */
export type MarketDataResearchProvenance = "live" | "cached" | "static" | "generated";

export interface MarketDataResearchQuote {
  symbol: string;
  provider: "yfinance" | "alpaca" | "hybrid";
  /** Truth about where this quote's values came from in this call (#117). */
  provenance: MarketDataResearchProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
  /** #930: set only on cache hits — the values are as old as cacheAgeMs, not fresh. */
  fromCache?: boolean;
  /** #930: milliseconds since the original live fetch, on cache hits only. */
  cacheAgeMs?: number;
  companyName?: string;
  name?: string;
  price: number;
  lastPrice?: number;
  change: number;
  changePercent: number;
  /** #923: present only when the live payload actually carries a bid — never price ± 0.05. */
  bid?: number;
  /** #923: present only when the live payload actually carries an ask — never price ± 0.05. */
  ask?: number;
  bidSize?: number;
  askSize?: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose: number;
  vwap?: number;
  trailingPE?: number;
  peRatio?: number;
  marketCap?: number;
  rsi14?: number;
  macdSignal?: string;
  marketState?: string;
  timestamp: string;
  currency?: string;
}

export interface MarketDataResearchHistoricalBar {
  /** "live" = fetched bars; "generated" = synthetic series from the market-data profile (#117). */
  provenance: MarketDataResearchProvenance;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
}

export interface MarketDataResearchCompanyFundamentals {
  /** Truth about where these fundamentals came from in this call (#117). */
  provenance: MarketDataResearchProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
  symbol: string;
  companyName: string;
  sector: string;
  industry: string;
  description: string;
  marketCap: number;
  enterpriseValue?: number;
  peTrailing?: number;
  peForward?: number;
  pegRatio?: number;
  priceToBook?: number;
  beta?: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  targetMeanPrice?: number;
  targetHighPrice?: number;
  targetLowPrice?: number;
  recommendationKey?: "strong_buy" | "buy" | "hold" | "underperform" | "sell";
  recommendationMean?: number;
  numberOfAnalystOpinions?: number;
  dividendYield?: number;
  profitMargins?: number;
  operatingMargins?: number;
  returnOnEquity?: number;
  revenue?: number;
  grossProfits?: number;
  ebitda?: number;
  freeCashflow?: number;
}

export interface AlpacaMarketSnapshot {
  /** "live" = fetched from Alpaca in this call; otherwise the market-data profile (#117). */
  provenance: MarketDataResearchProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
  symbol: string;
  assetClass: "us_equity" | "crypto";
  latestTrade: {
    price: number;
    size: number;
    timestamp: string;
  };
  latestQuote: {
    bidPrice: number;
    bidSize: number;
    askPrice: number;
    askSize: number;
    timestamp: string;
  };
  nbboSpread?: number;
  dailyBar: MarketDataResearchHistoricalBar;
  prevDailyBar: MarketDataResearchHistoricalBar;
  minuteBar?: MarketDataResearchHistoricalBar;
}

export interface MarketDataResearchReport {
  symbol: string;
  provider: "yfinance" | "alpaca" | "hybrid";
  /** Weakest provenance among quote, fundamentals, and bars (#117). */
  provenance: MarketDataResearchProvenance;
  quote: MarketDataResearchQuote;
  fundamentals: MarketDataResearchCompanyFundamentals;
  bars: MarketDataResearchHistoricalBar[];
  technicalSummary: {
    rsi14: number;
    macd: string;
    trend50vs200SMA: string;
    support: number;
    resistance: number;
    /**
     * Always true for this engine: support/resistance are price×0.94/×1.06
     * formulas and the MACD/trend labels come from a single price-vs-midpoint
     * comparison — heuristic estimates, not measured technicals (#117).
     */
    heuristic: boolean;
  };
  aiAnalysis: string;
  analystRating: string;
  agentAttestation: {
    did: string;
    signature: string;
    timestamp: string;
    /** Provenance of the attested inputs; bound into the signed payload (#117). */
    provenance: MarketDataResearchProvenance;
  };
}

export interface MarketDataResearchProviderStatus {
  provider: "yfinance" | "alpaca" | "hybrid";
  name: string;
  configured: boolean;
  mode: "live_api" | "market_data_open_data" | "simulated_engine" | "not_configured";
  capabilities: string[];
}

// =========================================================================
// Official E*TRADE API Models & Endpoints Contracts (Full Specification)
// =========================================================================

export interface ETradeTransaction {
  transactionId: string;
  accountId: string;
  transactionDate: number;
  postDate?: number;
  amount: number;
  description: string;
  transactionType: string;
  memo?: string;
  imageFlag?: boolean;
  instType?: string;
  detailsURI?: string;
}

export interface ETradeTransactionDetails {
  transactionId: string;
  accountId: string;
  transactionDate: number;
  amount: number;
  description: string;
  category?: {
    categoryId: string;
    categoryName: string;
    parentName?: string;
  };
  brokerage?: {
    product?: {
      symbol: string;
      securityType: string;
    };
    quantity?: number;
    price?: number;
    settlementDate?: number;
    fee?: number;
    memo?: string;
  };
}

export interface ETradeAlert {
  id: number | string;
  createTime: number;
  subject: string;
  status: "READ" | "UNREAD" | "DELETED";
  msgText?: string;
  readTime?: number;
  deleteTime?: number;
}

export interface ETradeAlertDetails {
  id: number | string;
  createTime: number;
  subject: string;
  msgText: string;
  readTime?: number;
  deleteTime?: number;
  symbol?: string;
  next?: string;
  prev?: string;
}

export interface ETradeProductLookup {
  symbol: string;
  description: string;
  type: string;
}

export interface ETradeOptionChainContract {
  optionCategory?: string;
  optionRootSymbol?: string;
  timeStamp?: number;
  adjustedFlag?: boolean;
  displaySymbol?: string;
  osiKey?: string;
  optionType: "CALL" | "PUT";
  strikePrice: number;
  symbol: string;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  lastPrice: number;
  volume?: number;
  openInterest?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  impliedVolatility?: number;
}

export interface ETradeOptionChain {
  symbol: string;
  underlyingPrice: number;
  raw?: Record<string, unknown>;
  selectedExpiry?: {
    year: number;
    month: number;
    day: number;
  };
  pairs: Array<{
    call?: ETradeOptionChainContract;
    put?: ETradeOptionChainContract;
  }>;
}

export interface ETradeOptionExpireDate {
  year: number;
  month: number;
  day: number;
  expiryType?: string;
}

export interface ETradeRemoteOrder {
  orderId: number | string;
  details?: string;
  orderType: string;
  orderValue?: number;
  status: "OPEN" | "EXECUTED" | "CANCELLED" | "INDIVIDUAL_FILLS" | "REJECTED";
  placedTime?: number;
  executedTime?: number;
  orderTerm?: string;
  priceType?: string;
  limitPrice?: number;
  stopPrice?: number;
  orderAction?: string;
  quantity?: number;
  symbol?: string;
}

export interface ETradeCancelOrderResult {
  success: boolean;
  orderId: string;
  message: string;
  timestamp: string;
}

// --- Omnichannel Trading Agent Communication Channels (Email & Slack) ---

export interface InboundEmailPayload {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  // Issue #1262 Phase 1: the raw Authentication-Results header (RFC 8601)
  // forwarded by the worker email handler; the channel intake parses
  // DKIM/SPF pass results from it to gate the email trade tier.
  authenticationResults?: string;
}

export interface EmailTradingResult {
  success: boolean;
  actionType: "quote" | "screener" | "preview" | "approval" | "rejection" | "portfolio" | "general" | "error" | "refusal";
  from: string;
  to: string;
  responseSubject: string;
  responseHtml: string;
  responseText: string;
  orderId?: string;
  orderStatus?: string;
  proposerDid: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface PreTradeApprovalDraft {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  estimatedPrice?: number | string;
  estimatedTotal?: number | string;
  commission?: number | string;
  proposerDid?: string;
  expiresAt?: string;
  notes?: string;
  channel?: string;
}

export interface SlackBlockKitPayload {
  channel?: string;
  text: string;
  blocks?: any[];
  thread_ts?: string;
  replace_original?: boolean;
}

export interface SlackEventResult {
  handled: boolean;
  actionType: "quote" | "screener" | "options_research" | "preview" | "approval" | "rejection" | "portfolio" | "general" | "challenge" | "ignored" | "snap" | "refusal" | "link";
  response?: SlackBlockKitPayload;
  orderId?: string;
  challenge?: string;
  proposerDid?: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface SlackInteractionResult {
  success: boolean;
  actionId: string;
  orderId?: string;
  status: "executed" | "rejected" | "decided" | "superseded" | "error";
  message: string;
  replacementBlocks?: any[];
  proposerDid?: string;
  authorizerDid?: string;
  timestamp: string;
}

// --- Cloudflare Voice Trading Agent Domain Models ---

export interface VoiceTranscriptMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: string;
  actionType?: string;
  orderId?: string;
  tradeDraft?: ETradeOrderDraft;
}

export interface VoiceTradingTurnRequest {
  transcript?: string;
  rawTranscript?: string;
  audioBase64?: string;
  audioFormat?: "pcm16" | "wav" | "mp3" | "opus";
  sampleRate?: number;
  sessionId?: string;
  userLogin?: string;
}

export interface VoiceTradingTurnResponse {
  success: boolean;
  spokenText: string;
  displayMarkdown: string;
  actionType: "quote" | "screener" | "options_screener" | "options_research" | "watchlist" | "preview" | "approval" | "rejection" | "portfolio" | "schedule" | "agentic_payment" | "capabilities" | "general" | "error";
  orderId?: string;
  orderDraft?: ETradeOrderDraft;
  orderStatus?: "previewed" | "executed" | "rejected" | "not_found";
  brokerOrderRef?: string;
  marketQuote?: ETradeQuote;
  screenedStocks?: ScreenedStockItem[];
  audioBase64?: string;
  audioFormat?: string;
  metrics?: {
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
  };
  proposerDid: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface VoiceSessionState {
  status: "idle" | "listening" | "thinking" | "speaking";
  transcript: VoiceTranscriptMessage[];
  interimTranscript: string | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
}

// ==========================================
// Cloudflare Agents Task Scheduling Models
// ==========================================

export type ScheduleExecutionType = "scheduled" | "delayed" | "cron" | "interval";

export interface AgentScheduleItem {
  id: string;
  callback: string;
  type: ScheduleExecutionType;
  time?: number;
  cron?: string;
  delayInSeconds?: number;
  intervalSeconds?: number;
  payload?: any;
}

export interface ScheduledTaskPayload {
  taskType: "etrade_token_renewal" | "market_screen" | "order_expiration" | "reminder" | string;
  userLogin?: string;
  orderId?: string;
  reminderId?: string;
  message?: string;
  sector?: string;
  environment?: string;
  maxItems?: number;
  broadcast?: boolean;
  [key: string]: unknown;
}

export interface ScheduledTaskResult<T = unknown> {
  success: boolean;
  taskType: string;
  data?: T;
  error?: string;
  timestamp: string;
}

// ==========================================
// Cloudflare Agentic Payments (x402 & MPP)
// ==========================================

export type AgenticPaymentProtocol = "x402" | "mpp";

export interface X402PaymentChallenge {
  version: string;
  network: "base" | "base-sepolia" | "ethereum" | "solana" | string;
  recipient: string;
  amount: number;
  currency: "USDC" | "USD" | string;
  facilitator: string;
  description: string;
  resource: string;
  nonce: string;
  expiresAt: number;
}

export interface X402PaymentProof {
  signature: string;
  payer: string;
  txHash?: string;
  nonce: string;
  timestamp: number;
  facilitatorToken?: string;
  /**
   * Issue #122: true when this proof was produced locally by
   * ETradeAgenticPaymentService.signPaymentProof, which holds no signing key
   * and settles nothing on-chain. A simulated proof is NOT a cryptographic
   * signature and must never be presented or accepted as one;
   * verifyPayment rejects simulated proofs outright.
   */
  simulated?: boolean;
}

export interface MppChallenge {
  protocol: "mpp";
  method: "tempo" | "card" | "stablecoin" | string;
  amount: string;
  currency: string;
  recipient: string;
  description: string;
  realm?: string;
  testnet?: boolean;
}

export interface MppPaymentProof {
  authorization: string;
  method: string;
  payer: string;
  receipt?: string;
}

export interface AgenticPaymentReceipt {
  receiptId: string;
  protocol: AgenticPaymentProtocol;
  resource: string;
  amount: number;
  currency: string;
  network: string;
  payer: string;
  recipient: string;
  /**
   * "verified" is reserved for receipts issued after an actual verification
   * (on-chain claim verification or the mppx gateway). Locally synthesised
   * records of simulated payments use "simulated" (issue #122).
   */
  status: "paid" | "verified" | "failed" | "simulated";
  /** Issue #122: true for locally synthesised records of simulated payments — no real payment was made or verified. */
  simulated?: boolean;
  txHash?: string;
  signature?: string;
  timestamp: string;
  proposerDid: string;
  authorizerDid?: string;
  note?: string;
}

export interface AgenticWalletStatus {
  walletAddress: string;
  network: string;
  balanceUSD: number;
  autoApproveLimitUSD: number;
  facilitatorUrl: string;
  protocol: "x402" | "mpp" | "hybrid";
  totalSpentUSD: number;
  totalEarnedUSD: number;
  transactionCount: number;
  /**
   * Issue #122: this service never reads an on-chain balance. balanceUSD is a
   * simulated local-ledger figure (see source/startingCreditUSD/note) and the
   * markers below must travel with it to every surface that renders it.
   */
  simulated: boolean;
  source: "local-ledger";
  startingCreditUSD: number;
  note: string;
}

export interface AgenticPaymentConfig {
  network?: string;
  recipient?: string;
  facilitatorUrl?: string;
  autoApproveLimitUSD?: number;
  walletKey?: string;
  mppSecretKey?: string;
}

export interface PaidTradingServiceTier {
  id: string;
  resource: string;
  name: string;
  description: string;
  priceUSD: number;
  rateLimitPerMin?: number;
}

export type PaymentRequiredCallback = (challenge: X402PaymentChallenge | MppChallenge) => Promise<boolean>;

// =========================================================================
// 1. Cloudflare Browser Agent & Rendering Models
// =========================================================================

export interface BrowserInspectOptions {
  url: string;
  selector?: string;
  waitForTimeoutMs?: number;
  screenshot?: boolean;
}

export interface BrowserInspectResult {
  success: boolean;
  url: string;
  title?: string;
  text?: string;
  tables?: Array<Array<string>>;
  screenshotBase64?: string;
  /**
   * Provenance of `screenshotBase64` (issue #120): "capture" only when the
   * image really came from Cloudflare Browser Rendering of the page;
   * "placeholder" when it is a locally generated illustration produced
   * because no browser capture was available. A placeholder contains no
   * page content and must never be presented as a screenshot of the page.
   */
  screenshotKind?: "capture" | "placeholder";
  error?: string;
  timestamp: string;
}

export interface TransactionSnapData {
  transactionId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_CLOSE" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | string;
  quantity: number;
  price?: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | string;
  status: "previewed" | "executed" | "filled" | "rejected" | "expired" | "cancelled" | string;
  totalValue?: number;
  environment?: string;
  accountKey?: string;
  commission?: number;
  timestamp?: string;
  /**
   * Issue #120: set ONLY by a flow that recorded an actual human approval
   * for this transaction (e.g. a Slack approve interaction, a conversational
   * approval, or the HITL authorize/execute call). The generated receipt
   * prints "Human-in-the-Loop Verified" only when this is true; otherwise
   * the receipt states that no human approval was recorded.
   */
  humanApproved?: boolean;
  notes?: string;
  legs?: Array<{
    action: string;
    symbol: string;
    strike?: number;
    expiry?: string;
    type?: string;
  }>;
}

export interface BrowserAgentSnapResult {
  success: boolean;
  transactionId?: string;
  symbol?: string;
  url?: string;
  slackWebhookUrl?: string;
  channel?: string;
  caption?: string;
  screenshotBase64?: string;
  error?: string;
  timestamp: string;
}

// =========================================================================
// 2. Trading Webhook Channels (TradingView, E*TRADE, Generic)
// =========================================================================

export interface TradingViewWebhookPayload {
  ticker: string;
  action: "BUY" | "SELL";
  orderType?: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  strategyName?: string;
  alertMessage?: string;
  passphrase?: string;
  timestamp?: string;
}

export interface ETradeWebhookPayload {
  eventType: "ORDER_FILLED" | "ORDER_CANCELLED" | "ORDER_REJECTED" | "ACCOUNT_UPDATE";
  orderId?: string;
  symbol?: string;
  filledQuantity?: number;
  avgPrice?: number;
  accountId?: string;
  timestamp: string;
}

export interface TradingWebhookEvent {
  id: string;
  provider: "tradingview" | "etrade" | "stripe" | "generic";
  eventType: string;
  payload: any;
  signature?: string;
  status: "received" | "processed" | "failed" | "rejected";
  receivedAt: string;
  processedAt?: string;
  orderRef?: string;
}

export interface OutboundWebhookConfig {
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

// =========================================================================
// 3. Cloudflare Sandbox (Containers & Quantitative Code Execution)
// =========================================================================

export interface SandboxExecutionRequest {
  command: string;
  timeoutMs?: number;
  envVars?: Record<string, string>;
  workingDir?: string;
}

export interface SandboxExecutionResult {
  /**
   * Issue #121 (audit F6): true only when a real container backend handled
   * the request (its `error` field reports backend failures). False means
   * NO backend is bound in this environment and the command was NOT run —
   * in that case `exitCode` is null and `stdout`/`stderr` are empty, because
   * this service never emulates shell execution or fabricates output.
   */
  executed: boolean;
  /** Process exit code from the real backend; null when nothing ran. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface QuantBacktestRequest {
  symbol: string;
  strategy: "sma_crossover" | "rsi_reversal" | "mean_reversion" | "breakout";
  startBars?: number;
  params?: Record<string, number>;
}

export interface QuantBacktestResult {
  symbol: string;
  strategy: string;
  /**
   * Issue #121 (audit F7): the price series is generated in code, never
   * historical market data. Metrics are genuinely computed from that
   * synthetic series; a metric that cannot be computed from the run
   * (e.g. win rate with no closed trades) is null, never default-filled.
   */
  dataSource: "synthetic";
  totalTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  sharpeRatio: number | null;
  maxDrawdownPct: number | null;
  netReturnPct: number | null;
  codeExecuted: string;
  logs: string;
  /** Plain-language statement of what this result is and is not. */
  note: string;
}

// =========================================================================
// 4. Think Harness for Deep Trade Validation
// =========================================================================

export type ThinkValidationPhase =
  | "market_condition"
  | "risk_limits"
  | "regulatory_rules"
  | "execution_feasibility"
  | "attestation";

export interface ThinkStepLog {
  phase: ThinkValidationPhase;
  status: "PASS" | "WARN" | "FAIL";
  reasoning: string;
  metricName?: string;
  metricValue?: any;
  threshold?: any;
}

/** Where a guardrail input actually came from (issue #37). */
export type ThinkInputSource = "provided" | "live" | "unavailable";

export interface ThinkTradeValidationResult {
  approved: boolean;
  overallConfidence: number;
  recommendation: "PROCEED_TO_HITL" | "REVISE_PARAMETERS" | "REJECT_RISK_LIMIT" | "INPUTS_UNAVAILABLE";
  /** Provenance of every input the decision rested on — a decision made
   *  without live state must say so, and unavailable inputs fail closed. */
  inputSources: { price: ThinkInputSource; accountBalance: ThinkInputSource; spread: ThinkInputSource };
  steps: ThinkStepLog[];
  proposedDraft?: any;
  reason: string;
  attestationDid: string;
  timestamp: string;
}

// =========================================================================
// 5. Durable Execution & Fibers
// =========================================================================

export interface FiberExecutionRecord {
  fiberId: string;
  name: string;
  status: "running" | "completed" | "failed" | "recovered";
  currentStep: number;
  totalSteps: number;
  stashedData: Record<string, any>;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export type AsyncJobStatus = "queued" | "running" | "completed" | "failed";

/** Issue #1123: job-graph classification. 'main' jobs own sub-jobs:
 *  'report' (generate the artifact), 'delivery' (send it on a channel),
 *  'notification' (lifecycle notice). */
export type AsyncJobKind = "main" | "report" | "delivery" | "notification";

/** Issue #1123: delivery/notification channel for sub-jobs. */
export type AsyncJobChannel = "email" | "slack" | "webhook";

/** Consolidation C3 (issue #1277, epic #1151; stage-layered
 *  scheduling, #1236): the unified pipeline's stages. C3 schedules
 *  generate (the run itself, recorded as the chain's main job),
 *  serve and deliver as stage jobs; feed and store join as stage
 *  jobs in C4, when the feed output contract and the generate→store
 *  split land. */
export type PipelineStage = "feed" | "generate" | "store" | "serve" | "deliver";

/** Consolidation C3 (#1277): per-stage timing carried on a schedule
 *  payload (validated by buildSchedulePayload in
 *  src/trading/screeningSchemas.ts) and on the run outcome the
 *  follow-up bridge consumes. Delays are whole seconds from the
 *  predecessor stage's completion, 0..604800. */
export interface StageChainConfig {
  /** Delay after the run (generate) completes before serve runs. */
  serveDelaySeconds?: number;
  /** Delay after serve completes before the deliver stages run. */
  deliverDelaySeconds?: number;
}

/** Issue #1355: context carried on every shard of a sharded
 *  scheduled screen, so any stage's completion hook can plan the
 *  next stage without re-reading the schedule. */
export interface ShardChainContext {
  chainId: string;
  universe: string;
  userLogin: string;
  environment?: "TEST" | "PROD";
  trigger?: "manual" | "scheduled";
  maxItems?: number;
  timestamp: string;
  channels: AsyncJobChannel[];
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
  reportBaseUrl?: string;
  stageChain?: StageChainConfig;
  /** Spacing between shard starts inside a stage (ms). 0 = start together. */
  staggerMs?: number;
  /** Screen family for chains sharing the shard execution framework. */
  screenType?: "stock" | "options";
  /** Option screen inputs and immutable symbol-level inputs captured at submission. */
  options?: {
    symbols: string[];
    thesis: string;
    targetDate: string;
    riskProfile: "conservative" | "balanced" | "aggressive";
    allowedStrategies?: string[];
    /** Issue #2091: scheduled chains judge every wanted strategy. */
    evaluateAllStrategies?: boolean;
    eventCalendarBySymbol?: Record<string, unknown>;
  };
}

/** Issue #1123: optional graph fields on a job submission. */
export interface AsyncJobGraphFields {
  parentJobId?: string;
  jobKind?: AsyncJobKind;
  channel?: AsyncJobChannel;
  /** Overrides the capability-derived label (sub-jobs carry human names). */
  displayName?: string;
  /** Consolidation C3 (#1277): not-before time (ISO). The job is
   *  armed at the remaining delay and the executor refuses to claim
   *  it earlier — per-stage timing on the async-job substrate. */
  runAt?: string;
  /** Consolidation C3 (#1277): the pipeline stage this job executes,
   *  when it belongs to a stage chain. */
  stage?: PipelineStage;
  /** Consolidation C3 (#1277): the stage chain this job belongs to
   *  (links the stage rows of one run). */
  chainId?: string;
}

export interface AsyncJobRecord {
  jobId: string;
  sessionId: string;
  capability: string;
  label: string;
  status: AsyncJobStatus;
  /** Issue #1123: graph fields; jobKind defaults to 'main' for legacy rows. */
  parentJobId?: string;
  jobKind: AsyncJobKind;
  channel?: AsyncJobChannel;
  /** Consolidation C3 (#1277): stage identity for chained jobs. */
  stage?: PipelineStage;
  chainId?: string;
  /** Consolidation C3 (#1277): the job's not-before time (ISO), when deferred. */
  notBefore?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
  responseStatus?: number;
}

export interface AsyncJobPayload {
  jobId: string;
}

export type AsyncJobSubmission =
  | ({
      capability: "http.request";
      payload: {
        pathAndQuery: string;
        method: string;
        headers: Record<string, string>;
        body: string;
      };
    } & AsyncJobGraphFields)
  | ({
      capability: "mcp.tool";
      payload: {
        toolName: string;
        arguments: Record<string, unknown>;
        /**
         * #2341 (Agent Mesh S5): the acting identity the turn
         * adapter stamped server-side at queue time (never from
         * tool arguments); the executor threads it into the tool
         * context's actingLogin carrier. Absent = the queued call
         * carries no acting identity and identity-gated tools fail
         * closed at execution.
         */
        actingLogin?: string;
      };
    } & AsyncJobGraphFields)
  | ({
      capability: "nlq.execute";
      payload: {
        query: string;
        userLogin: string;
        // #1722: run-level NLQ_MODE value for this job, plus the
        // optional session/user carriers set by the job submitter
        // (see src/config/nlqModes.ts). Absent levels fall through
        // to the Worker env NLQ_MODE, then the built-in "rest".
        mode?: unknown;
        scopedNlqModes?: { session?: unknown; user?: unknown };
      };
    } & AsyncJobGraphFields)
  | ({
      capability: "task.draft";
      payload: {
        title: string;
        dueDate?: string;
        priority?: "low" | "medium" | "high" | "urgent";
        assignee?: string;
      };
    } & AsyncJobGraphFields)
  | ({
      /** Issue #1123: screener follow-up sub-jobs (report first; the
       *  delivery/notification capabilities arrive with S3/S4). */
      capability: "followup.report";
      payload: {
        outcome: import("./services/screenerFollowups").ScreenerRunOutcome;
        userLogin: string;
        /** Consolidation C3 (#1277): when this job is a chain's serve
         *  stage, the chain config + id ride the payload so the
         *  deliver hop planned at its completion can read its own
         *  delay and chain identity from the completed stage's
         *  record. */
        stageChain?: StageChainConfig;
        chainId?: string;
        /** Consolidation C3 (#1277): per-stage retry marker, as on
         *  followup.deliver. */
        retryOf?: string;
      };
    } & AsyncJobGraphFields)
  | ({
      /** Issue #1123 S3: one delivery of the shared report artifact on
       *  one channel. skipReason pre-completes it as 'skipped'.
       *  S5c: approvedConfirmationId marks a delivery released from a
       *  #277 hold — the executor sends it without re-holding. */
      capability: "followup.deliver";
      payload: {
        outcome: import("./services/screenerFollowups").ScreenerRunOutcome;
        userLogin: string;
        channel: AsyncJobChannel;
        artifacts: Array<{ key: string; fileName: string }>;
        skipReason?: string;
        approvedConfirmationId?: string;
        /** Consolidation C3 (#1277): set on a per-stage retry — the
         *  job id of the failed job this submission retries. */
        retryOf?: string;
      };
    } & AsyncJobGraphFields)
  | ({
      /** Issue #1123 S4: one lifecycle notification (started /
       *  completed / failed / delivered) on one channel. */
      capability: "followup.notify";
      payload: {
        event: import("./services/screenerFollowups").FollowupLifecycleEvent;
        outcome: import("./services/screenerFollowups").ScreenerRunOutcome;
        userLogin: string;
        channel: AsyncJobChannel;
        detail?: string;
      };
    } & AsyncJobGraphFields)
  | ({
      /** Issue #1355: one shard of a sharded scheduled screen.
       *  `inputs` carries the previous stage's outputs the planner
       *  embedded (e.g. store keys) — never datasets (those live in
       *  sibling rows' result_json). */
      capability: "shard.execute";
      payload: {
        shard: { stage: "feed" | "generate" | "store"; key: string };
        chain: ShardChainContext;
        inputs?: Record<string, unknown>;
      };
    } & AsyncJobGraphFields)
  | ({
      /** Consolidation #1236 (feed seam): the feed stage job —
       *  produce + store one universe snapshot artifact per symbol.
       *  The payload carries descriptors, never snapshot bytes
       *  (those live in mas_feed_snapshots). With chainTo, feed
       *  completion plans the generate stage (an http.request job
       *  to the discovery trigger route); without it, the job is a
       *  standalone refresh. */
      capability: "feed.snapshot";
      payload: import("./services/feedSnapshotJob").FeedSnapshotJobPayload;
    } & AsyncJobGraphFields);

export interface TWAPOrderConfig {
  symbol: string;
  action: "BUY" | "SELL";
  totalQuantity: number;
  slices: number;
  intervalSeconds: number;
  maxPrice?: number;
}
