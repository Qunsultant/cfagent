/**
 * src/data/ormColumnMaps.ts — #4386 (#4282 P6c): the ORM core's
 * column maps (record prop -> storage column), verbatim from the
 * pre-port ORM constructor.
 *
 * Moved here from doSqliteOrmAdapters.ts so the DO DML catalogue
 * entries (src/data/schemaComponent/doDmlEntries.ts) can import
 * them without a load-order cycle: the entries module is loaded
 * by the catalogue, which the adapters module imports — had the
 * maps stayed in the adapters module, the entries' top-level
 * array would read them before the adapters module's body ran
 * (TDZ). This module imports nothing, so it is a leaf both
 * modules can load. doSqliteOrmAdapters.ts re-exports every map,
 * so all existing import paths (d1MarketplaceAdapter,
 * doSqliteMarketplaceAdapter, the D1 catalogue entries) keep
 * working unchanged.
 *
 * #CDO-mha7
 */

/* Column maps — verbatim from the pre-port ORM constructor. */
export const CATEGORY_COLUMN_MAP = {
  id: "id",
  name: "name",
  slug: "slug",
  description: "description",
  icon: "icon",
  isActive: "is_active",
  sortOrder: "sort_order",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const REFERRAL_COLUMN_MAP = {
  id: "id",
  userLogin: "session_id",
  title: "title",
  url: "url",
  category: "category",
  rewardText: "reward_text",
  clicks: "clicks",
  signups: "signups",
  createdAt: "created_at",
} as const;

export const AD_COLUMN_MAP = {
  id: "id",
  title: "title",
  tagline: "tagline",
  sponsor: "sponsor",
  badge: "badge",
  url: "url",
  ctaText: "cta_text",
  accentColor: "accent_color",
  impressions: "impressions",
  clicks: "clicks",
  createdAt: "created_at",
} as const;

export const EXTERNAL_AD_COLUMN_MAP = {
  id: "id",
  name: "name",
  network: "network",
  placement: "placement",
  title: "title",
  tagline: "tagline",
  ctaText: "cta_text",
  targetUrl: "target_url",
  bannerImageUrl: "banner_image_url",
  cpmRate: "cpm_rate",
  cpcRate: "cpc_rate",
  impressions: "impressions",
  clicks: "clicks",
  earnings: "earnings",
  isActive: "is_active",
  createdAt: "created_at",
} as const;

export const TRANSACTION_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  action: "action",
  amount: "amount",
  currency: "currency",
  customer: "customer",
  gateway: "gateway",
  gatewayRef: "gateway_ref",
  status: "status",
  checkoutUrl: "checkout_url",
  proposerDid: "proposer_did",
  authorizerDid: "authorizer_did",
  proofSignature: "proof_signature",
  note: "note",
  createdAt: "created_at",
  updatedAt: "updated_at",
  // Issue #3182: last in the map, matching the DDL position, so
  // replace()'s INSERT column order and the PRAGMA column order
  // agree on fresh and migrated tables alike.
  tenantId: "tenant_id",
} as const;

export const MESSAGE_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  role: "role",
  content: "content",
  agent: "agent",
  createdAt: "created_at",
} as const;

export const MEMORY_COLUMN_MAP = {
  key: "key",
  value: "value",
  updatedAt: "updated_at",
} as const;

export const EVENT_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  type: "type",
  agent: "agent",
  payload: "payload",
  createdAt: "created_at",
  previousEventHash: "previous_event_hash",
  eventHash: "event_hash",
  // Issue #6100: attribution envelope, first-class columns.
  platformId: "platform_id",
  tenantId: "tenant_id",
  principalId: "principal_id",
  correlationId: "correlation_id",
  traceId: "trace_id",
} as const;

/**
 * The COMPLETED reports map (#2345): the pre-port map's eight
 * columns plus user_login and body_r2_key, which the canonical
 * writer has stored all along (audit V-5).
 */
export const CANONICAL_REPORT_COLUMN_MAP = {
  id: "id",
  runId: "run_id",
  generationId: "generation_id",
  title: "title",
  source: "source",
  summary: "summary",
  body: "body",
  createdAt: "created_at",
  userLogin: "user_login",
  bodyR2Key: "body_r2_key",
  fanoutOutcome: "fanout_outcome",
} as const;

export const WEBHOOK_REPLAY_COLUMN_MAP = {
  nonce: "nonce",
  source: "source",
  createdAt: "created_at",
  expiresAt: "expires_at",
} as const;

export const TRADE_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  symbol: "symbol",
  action: "action",
  orderType: "order_type",
  quantity: "quantity",
  price: "price",
  totalValue: "total_value",
  status: "status",
  orderRef: "order_ref",
  proposerDid: "proposer_did",
  authorizerDid: "authorizer_did",
  proofSignature: "proof_signature",
  previewNotes: "preview_notes",
  expirationScheduleId: "expiration_schedule_id",
  broker: "broker",
  priceSourceJson: "price_source",
  mode: "mode",
  stopPrice: "stop_price",
  timeInForce: "time_in_force",
  // Issue #5100 (F3 of #5094): the resolved binding tuple, stamped on the
  // draft at preview so execute can prove the draft's account.
  accountId: "account_id",
  accountType: "account_type",
  bindingScope: "binding_scope",
  bindingSource: "binding_source",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const WATCHLIST_COLUMN_MAP = {
  id: "id",
  name: "name",
  userLogin: "user_login",
  symbolsJson: "symbols_json",
  itemsJson: "items_json",
  source: "source",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const OPTIONS_CHAIN_CACHE_COLUMN_MAP = {
  id: "id",
  symbol: "symbol",
  expirationsJson: "expirations_json",
  chainsJson: "chains_json",
  fetchedAt: "fetched_at",
  expiresAt: "expires_at",
  contractCount: "contract_count",
} as const;
