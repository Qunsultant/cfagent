/**
 * Issue #3289 (sub-issue of #3241), slice 2 — the Products
 * section of Platform Admin: products as identity, versions
 * as immutable terms snapshots.
 *
 * A product is a row; a version is a plan row (subscription
 * products) or a catalogue row (per-run products). A price
 * change is always a NEW version with an effective date —
 * never an in-place edit. A new version moves NO ONE by
 * itself: existing holders stay grandfathered until moved,
 * and new customers buy the current effective version for
 * their segment. The gate's rules do not change; only the
 * price source it reads from gained version resolution.
 *
 * This section is the operator read/write surface for that
 * model: product list, per-segment version chains, new
 * product/version forms, approve/deactivate, and the
 * "move all customers to current pricing" bulk action.
 * Catalogue approval stays in #2739's UI (the payment
 * assurance tab) — this section shows catalogue approval
 * status read-only and links there. Referral-code rules are
 * keyed by product id and configured here (#3307 slice 2):
 * one rule form per issuer plus code issue / list / revoke,
 * inside each product's view — no referral mechanics live
 * anywhere else in this section.
 * The per-product ladder position (issue #3246) is edited
 * in each row: 1 = lowest, empty = unranked, the Free
 * baseline fixed at 1.
 *
 * Operator-only: every route returns 403 for a non-operator.
 * All data is operator data — no hardcoded prices, dates, or
 * rules anywhere in this file.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Select, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  DEFAULT_SEGMENT,
  FREE_PRODUCT_ID,
  resolveEffectiveVersion,
  type BulkMoveRecord,
  type ProductRecord,
  type VersionMoveRecord,
} from "../data/productPorts";
import { PRICE_FAMILIES } from "../data/priceCataloguePorts";

/** Plan-row version as returned by the products routes. */
export interface PlanVersionView {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
  includedRuns: number;
  trialDays: number | null;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAtMs: number | null;
  active: boolean;
  productId: string;
  segment: string;
  version: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  billingPeriod: string;
  featuresJson: string | null;
  stripePriceId: string | null;
}

/** Catalogue-row version as returned by the products routes. */
export interface CatalogueVersionView {
  id: string;
  family: string;
  priceUSD: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAtMs: number | null;
  productId: string;
  segment: string;
  version: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
}

/** Runs-pack-row version as returned by the products routes (slice 3). */
export interface RunsPackVersionView {
  id: string;
  productId: string;
  version: number;
  segment: string;
  runs: number;
  priceUSD: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAtMs: number | null;
  active: boolean;
  effectiveFromMs: number;
  effectiveToMs: number | null;
}

export type VersionView = PlanVersionView | CatalogueVersionView | RunsPackVersionView;

export interface ProductEntry {
  product: ProductRecord;
  versions: VersionView[];
}

interface BulkMovePreviewSegment {
  segment: string;
  targetVersionId: string | null;
  targetReady: boolean;
  holderCount: number;
  fromVersions: Array<{ versionId: string; count: number }>;
}

interface BulkMoveResult {
  bulkMove: BulkMoveRecord | null;
  preview: BulkMovePreviewSegment[];
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  hasMore: boolean;
  failures: Array<{ userId: string; subscriptionId: string; error: string }>;
}

const isPlanVersion = (version: VersionView): version is PlanVersionView => "periodDays" in version;

const isRunsPackVersion = (version: VersionView): version is RunsPackVersionView => "runs" in version;

/** A version the operator manages here: a plan or a pack (never a catalogue row). */
type ManageableVersionView = PlanVersionView | RunsPackVersionView;

function formatMoney(priceUSD: number): string {
  return `$${priceUSD.toFixed(2)}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Segments sorted with "default" first, then alphabetical. */
function sortedSegments(segments: Iterable<string>): string[] {
  return [...segments].sort((a, b) =>
    a === DEFAULT_SEGMENT ? -1 : b === DEFAULT_SEGMENT ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
}

function groupBySegment(versions: VersionView[]): Map<string, VersionView[]> {
  const groups = new Map<string, VersionView[]>();
  for (const version of versions) {
    const list = groups.get(version.segment) ?? [];
    list.push(version);
    groups.set(version.segment, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.effectiveFromMs - b.effectiveFromMs || a.version - b.version);
  }
  return groups;
}

function versionLabel(version: VersionView | undefined): string {
  if (!version) return "unknown version";
  return `v${version.version} · ${formatMoney(version.priceUSD)}`;
}

function featuresOf(version: PlanVersionView): string[] {
  if (!version.featuresJson) return [];
  try {
    const parsed: unknown = JSON.parse(version.featuresJson);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * apiFetch + JSON parse, throwing on a non-OK status with the
 * server's error message — so call sites handle failures in
 * try/catch instead of checking res.ok at every call.
 * (apiFetch itself returns the Response and never throws on
 * an HTTP error status.)
 */
async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error((typeof data.error === "string" && data.error) || `Request failed (${res.status}).`);
  }
  return data as T;
}

/**
 * Issue #3246 (sub-issue of #3241), slice 2 — the per-product
 * ladder-position editor. Rank is the explicit operator order the
 * upgrade-offer ladder reads first (1 = lowest; null = unranked,
 * the derived order applies). The Free baseline product is fixed
 * at rank 1 server-side and shows no edit control. An empty input
 * clears the rank to null. Client-side validation mirrors the
 * server rule (a positive whole number) and renders the catalog
 * message on invalid input; the server remains authoritative.
 */
function ProductRankEditor({
  product,
  onChanged,
}: {
  product: ProductRecord;
  onChanged: () => Promise<void>;
}) {
  const isFree = product.id === FREE_PRODUCT_ID;
  const [input, setInput] = useState(product.rank === null ? "" : String(product.rank));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (isFree) {
    return (
      <div>
        Ladder position: {product.rank === null ? "Unranked" : product.rank} (fixed — the Free baseline is
        always the lowest rung)
      </div>
    );
  }

  const save = async () => {
    const trimmed = input.trim();
    let rank: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError(codedMessage("FAILURE_PRODUCT_RANK_INVALID"));
        return;
      }
      rank = parsed;
    }
    setSaving(true);
    setError("");
    try {
      await apiJson(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/rank`,
        {
          method: "POST",
          body: JSON.stringify({ rank }),
        },
      );
      await onChanged();
    } catch (err: any) {
      setError(err.message || "Failed to save ladder position.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div>
        Ladder position: {product.rank === null ? "Unranked" : product.rank} (1 = lowest; empty clears the rank)
      </div>
      <TextInput
        label="Ladder position"
        type="number"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <Button size="sm" loading={saving} onClick={() => void save()}>
        Save ladder position
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

export function ProductsSection() {
  const [entries, setEntries] = useState<ProductEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"subscription" | "per_run" | "runs_pack">("subscription");
  const [newDescription, setNewDescription] = useState("");
  const [newRank, setNewRank] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await apiJson<{ products: ProductEntry[] }>(
        "/api/payments/agentic/commercial/products",
      );
      setEntries(body.products ?? []);
    } catch (err: any) {
      setError(err.message || "Failed to load products.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createProduct = async () => {
    if (!newName.trim()) {
      setCreateError("A product name is required.");
      return;
    }
    // Ladder position is optional on create: empty means unranked
    // (omitted from the body; the route reads an absent rank as
    // null). A provided value must be a positive whole number.
    let rank: number | undefined;
    const rankTrimmed = newRank.trim();
    if (rankTrimmed !== "") {
      const parsed = Number(rankTrimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setCreateError(codedMessage("FAILURE_PRODUCT_RANK_INVALID"));
        return;
      }
      rank = parsed;
    }
    setCreating(true);
    setCreateError("");
    try {
      await apiJson("/api/payments/agentic/commercial/products", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          kind: newKind,
          description: newDescription.trim() ? newDescription.trim() : null,
          ...(rank === undefined ? {} : { rank }),
        }),
      });
      setNewName("");
      setNewDescription("");
      setNewRank("");
      setShowNewProduct(false);
      setNote(`Product "${newName.trim()}" created. Add a version to make it sellable.`);
      await load();
    } catch (err: any) {
      setCreateError(err.message || "Failed to create product.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="products-panel">
      <Stack gap="2">
        <div>
          <h2>Products</h2>
          <p>
            Products are identity; versions are immutable terms snapshots. A price change is a new version with an
            effective date — never an edit. A new version moves no one by itself: existing customers stay on the
            version they hold until moved, and new customers buy the current effective version for their segment.
          </p>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {note && <Notice tone="success">{note}</Notice>}
        {loading && <p>Loading products…</p>}
        {!loading && entries && entries.length === 0 && <p>No products yet. Create the first product below.</p>}
        {!loading && entries && entries.length > 0 && (
          <Stack gap="2">
            {entries.map(({ product, versions }) => {
              const isFree = product.id === FREE_PRODUCT_ID;
              const expanded = expandedId === product.id;
              const groups = groupBySegment(versions);
              const currentSummary = sortedSegments(groups.keys())
                .map((segment) => {
                  const effective = resolveEffectiveVersion(groups.get(segment) ?? [], segment, Date.now());
                  return effective ? `${segment}: ${formatMoney(effective.priceUSD)}` : `${segment}: no current version`;
                })
                .join(" · ");
              return (
                <div key={product.id} data-testid={`product-row-${product.id}`}>
                  <Stack gap="1">
                    <div>
                      <strong>{product.name}</strong>{" "}
                      <span>
                        {product.kind === "subscription"
                          ? "Subscription"
                          : product.kind === "runs_pack"
                            ? "Runs pack"
                            : "Per-run"}
                      </span>{" "}
                      {isFree && <span>· Read-only baseline</span>}
                      {product.description && <div>{product.description}</div>}
                      <div>
                        {versions.length} version{versions.length === 1 ? "" : "s"}
                        {currentSummary ? ` — current: ${currentSummary}` : ""}
                      </div>
                      <ProductRankEditor product={product} onChanged={load} />
                    </div>
                    <div>
                      <Button
                        size="sm"
                        onClick={() => setExpandedId(expanded ? null : product.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "Collapse" : "View versions"}
                      </Button>
                    </div>
                    {expanded && (
                      <ProductDetail
                        entry={{ product, versions }}
                        onChanged={async () => {
                          await load();
                        }}
                        onNote={setNote}
                      />
                    )}
                  </Stack>
                </div>
              );
            })}
          </Stack>
        )}
        <div>
          {!showNewProduct ? (
            <Button onClick={() => setShowNewProduct(true)}>New product</Button>
          ) : (
            <Stack gap="1">
              <TextInput label="Product name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Select label="Kind" value={newKind} onChange={(e) => setNewKind(e.target.value as "subscription" | "per_run" | "runs_pack")}>
                <option value="subscription">Subscription</option>
                <option value="per_run">Per-run</option>
                <option value="runs_pack">Runs pack</option>
              </Select>
              <TextInput
                label="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              <TextInput
                label="Ladder position (optional)"
                type="number"
                value={newRank}
                onChange={(e) => setNewRank(e.target.value)}
              />
              {createError && <Notice tone="danger">{createError}</Notice>}
              <div>
                <Button loading={creating} onClick={() => void createProduct()}>
                  Create product
                </Button>{" "}
                <Button variant="secondary" onClick={() => setShowNewProduct(false)}>
                  Cancel
                </Button>
              </div>
            </Stack>
          )}
        </div>
      </Stack>
    </div>
  );
}

/**
 * Issue #3307 (sub-issue of #3241), slice 2 — referral-code
 * rules + code management inside a product's view.
 *
 * Rules are keyed by (productId, issuer) and are the ONLY source
 * of issuance terms; a missing or inactive rule disables codes
 * for that product and issuer (fail-closed). The operator saves
 * terms here; nothing is live until the rule is active. Codes
 * confer runs only — never tier, never credits, never a price,
 * never access. The plaintext of an issued code is shown ONCE,
 * in the issuing session, and never rendered again.
 */
const REFERRAL_CODE_BASE = "/api/payments/agentic/commercial";
const REFERRAL_ISSUERS = ["platform_admin", "tenant_admin", "user"] as const;
type ReferralIssuer = (typeof REFERRAL_ISSUERS)[number];

interface ReferralCodeRuleView {
  id: string;
  productId: string;
  issuer: string;
  runsPerCode: number;
  reusable: boolean;
  expiryDays: number | null;
  attributionMode: string;
  maxRedemptionsPerCode: number | null;
  maxRedemptionsPerLogin: number | null;
  globalCap: number | null;
  redemptionCount: number;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

interface PublicReferralCodeView {
  id: string;
  displayPrefix: string;
  ruleId: string;
  productId: string;
  kind: string;
  issuerLogin: string;
  issuerKind: string;
  referrerUserId: string | null;
  tenantScope: string | null;
  runs: number;
  reusable: boolean;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  redemptionCount: number;
  createdAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReferralCodeRuleView(value: unknown): value is ReferralCodeRuleView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.productId === "string" &&
    typeof value.issuer === "string" &&
    typeof value.runsPerCode === "number" &&
    typeof value.reusable === "boolean" &&
    (value.expiryDays === null || typeof value.expiryDays === "number") &&
    typeof value.attributionMode === "string" &&
    (value.maxRedemptionsPerCode === null || typeof value.maxRedemptionsPerCode === "number") &&
    (value.maxRedemptionsPerLogin === null || typeof value.maxRedemptionsPerLogin === "number") &&
    (value.globalCap === null || typeof value.globalCap === "number") &&
    typeof value.redemptionCount === "number" &&
    typeof value.active === "boolean"
  );
}

function isPublicReferralCodeView(value: unknown): value is PublicReferralCodeView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.displayPrefix === "string" &&
    typeof value.productId === "string" &&
    typeof value.kind === "string" &&
    typeof value.issuerLogin === "string" &&
    typeof value.issuerKind === "string" &&
    typeof value.runs === "number" &&
    typeof value.reusable === "boolean" &&
    (value.expiresAtMs === null || typeof value.expiresAtMs === "number") &&
    (value.revokedAtMs === null || typeof value.revokedAtMs === "number") &&
    typeof value.redemptionCount === "number"
  );
}

/** The PROPOSED starting values a new rule form is pre-filled with (design §2.4). */
const PROPOSED_RULE_DEFAULTS = {
  runsPerCode: 5,
  reusable: false,
  expiryDays: 30,
  attributionMode: "ledger",
  maxRedemptionsPerCode: 1,
  maxRedemptionsPerLogin: 1,
  globalCap: null as number | null,
  active: false,
};

function ReferralRuleForm({
  productId,
  issuer,
  rule,
  onSaved,
  onNote,
}: {
  productId: string;
  issuer: ReferralIssuer;
  rule: ReferralCodeRuleView | null;
  onSaved: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const initial = rule ?? { ...PROPOSED_RULE_DEFAULTS, id: "", productId, issuer };
  const [runsPerCode, setRunsPerCode] = useState(String(initial.runsPerCode));
  const [reusable, setReusable] = useState(initial.reusable ? "1" : "0");
  const [expiryDays, setExpiryDays] = useState(
    initial.expiryDays === null ? "" : String(initial.expiryDays),
  );
  const [attributionMode, setAttributionMode] = useState(initial.attributionMode);
  const [maxPerCode, setMaxPerCode] = useState(
    initial.maxRedemptionsPerCode === null ? "" : String(initial.maxRedemptionsPerCode),
  );
  const [maxPerLogin, setMaxPerLogin] = useState(
    initial.maxRedemptionsPerLogin === null ? "" : String(initial.maxRedemptionsPerLogin),
  );
  const [globalCap, setGlobalCap] = useState(
    initial.globalCap === null ? "" : String(initial.globalCap),
  );
  const [active, setActive] = useState(initial.active ? "1" : "0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const parsedRuns = Number(runsPerCode);
    if (!Number.isInteger(parsedRuns) || parsedRuns < 1) {
      setError("Runs per code must be a positive whole number.");
      return;
    }
    const parseCap = (value: string, name: string): number | null => {
      if (value.trim() === "") return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number or empty (uncapped).`);
      return parsed;
    };
    let expiry: number | null = null;
    let perCode: number | null = null;
    let perLogin: number | null = null;
    let cap: number | null = null;
    try {
      if (expiryDays.trim() !== "") {
        const parsed = Number(expiryDays);
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Expiry days must be a positive whole number or empty (no expiry).");
        expiry = parsed;
      }
      perCode = parseCap(maxPerCode, "Max redemptions per code");
      perLogin = parseCap(maxPerLogin, "Max redemptions per login");
      cap = parseCap(globalCap, "Global cap");
    } catch (err: any) {
      setError(err.message || "Invalid rule values.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiJson(`${REFERRAL_CODE_BASE}/referral-code-rules`, {
        method: "POST",
        body: JSON.stringify({
          productId,
          issuer,
          runsPerCode: parsedRuns,
          reusable: reusable === "1",
          expiryDays: expiry,
          attributionMode,
          maxRedemptionsPerCode: perCode,
          maxRedemptionsPerLogin: perLogin,
          globalCap: cap,
          active: active === "1",
        }),
      });
      onNote(`Referral-code rule saved for ${issuer} (${active === "1" ? "active" : "inactive"}).`);
      await onSaved();
    } catch (err: any) {
      setError(err.message || "Failed to save the rule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div>
        <strong>{issuer}</strong>
        {rule
          ? ` — ${rule.active ? "Active" : "Inactive"} · ${rule.redemptionCount} redemptions under this rule`
          : " — No rule yet: codes are disabled for this issuer until a rule is saved and activated."}
      </div>
      <TextInput
        label="Runs per code"
        type="number"
        value={runsPerCode}
        onChange={(e) => setRunsPerCode(e.target.value)}
      />
      <Select
        label="One-time or reusable"
        value={reusable}
        onChange={(e) => setReusable(e.target.value)}
      >
        <option value="0">One-time (a login redeems a given code at most once)</option>
        <option value="1">Reusable (subject to the per-login cap)</option>
      </Select>
      <TextInput
        label="Expiry days (empty = no expiry)"
        type="number"
        value={expiryDays}
        onChange={(e) => setExpiryDays(e.target.value)}
      />
      <Select
        label="Attribution mode (referral codes only)"
        value={attributionMode}
        onChange={(e) => setAttributionMode(e.target.value)}
        hint="Ledger writes the referrer link through the referral-credit ledger; none writes nothing even for referral codes. Invite codes never attribute."
      >
        <option value="ledger">Ledger</option>
        <option value="none">None</option>
      </Select>
      <TextInput
        label="Max redemptions per code (empty = uncapped)"
        type="number"
        value={maxPerCode}
        onChange={(e) => setMaxPerCode(e.target.value)}
      />
      <TextInput
        label="Max redemptions per login (empty = uncapped)"
        type="number"
        value={maxPerLogin}
        onChange={(e) => setMaxPerLogin(e.target.value)}
      />
      <TextInput
        label="Global cap (empty = uncapped)"
        type="number"
        value={globalCap}
        onChange={(e) => setGlobalCap(e.target.value)}
      />
      <Select label="Rule state" value={active} onChange={(e) => setActive(e.target.value)}>
        <option value="0">Inactive (codes disabled)</option>
        <option value="1">Active</option>
      </Select>
      <Button size="sm" loading={saving} onClick={() => void save()}>
        Save rule
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function ReferralCodeRulesPanel({
  productId,
  onChanged,
  onNote,
}: {
  productId: string;
  onChanged: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const [rules, setRules] = useState<ReferralCodeRuleView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await apiJson<{ productId: string; rules: unknown }>(
        `${REFERRAL_CODE_BASE}/referral-code-rules?productId=${encodeURIComponent(productId)}`,
      );
      const rows = Array.isArray(body.rules) ? body.rules.filter(isReferralCodeRuleView) : [];
      setRules(rows);
    } catch (err: any) {
      setError(err.message || "Failed to load referral-code rules.");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h3>Referral-code rules</h3>
      <p>
        Rules are keyed by this product and survive version changes. Terms are snapshotted onto a code at
        issuance, so a later rule edit never reprices outstanding codes; caps are read live at redemption,
        so tightening a cap affects outstanding codes immediately. Deactivating a rule instantly disables
        its outstanding codes.
      </p>
      {loading && <p>Loading referral-code rules…</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!loading &&
        !error &&
        REFERRAL_ISSUERS.map((issuer) => (
          <ReferralRuleForm
            key={issuer}
            productId={productId}
            issuer={issuer}
            rule={rules?.find((row) => row.issuer === issuer) ?? null}
            onSaved={load}
            onNote={onNote}
          />
        ))}
    </div>
  );
}

function ReferralCodeManagementPanel({ productId }: { productId: string }) {
  const [codes, setCodes] = useState<PublicReferralCodeView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("referral");
  const [issuer, setIssuer] = useState("platform_admin");
  const [referrerUserId, setReferrerUserId] = useState("");
  const [tenantScope, setTenantScope] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [issuedPlaintext, setIssuedPlaintext] = useState<string | null>(null);
  const [issuedPrefix, setIssuedPrefix] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await apiJson<{ productId: string; codes: unknown }>(
        `${REFERRAL_CODE_BASE}/referral-codes?productId=${encodeURIComponent(productId)}`,
      );
      const rows = Array.isArray(body.codes) ? body.codes.filter(isPublicReferralCodeView) : [];
      setCodes(rows);
    } catch (err: any) {
      setError(err.message || "Failed to load referral codes.");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async () => {
    if (issuer === "tenant_admin" && tenantScope.trim() === "") {
      setIssueError("Tenant scope is required for tenant-admin issuance.");
      return;
    }
    setIssuing(true);
    setIssueError("");
    setIssuedPlaintext(null);
    try {
      const body = await apiJson<{ code: unknown; plaintext: string }>(
        `${REFERRAL_CODE_BASE}/referral-codes/issue`,
        {
          method: "POST",
          body: JSON.stringify({
            productId,
            kind,
            issuer,
            referrerUserId: referrerUserId.trim() === "" ? null : referrerUserId.trim(),
            tenantScope: tenantScope.trim() === "" ? null : tenantScope.trim(),
          }),
        },
      );
      if (typeof body.plaintext !== "string" || !body.plaintext) {
        throw new Error("The issue route did not return a code value.");
      }
      setIssuedPlaintext(body.plaintext);
      setIssuedPrefix(
        isPublicReferralCodeView(body.code) ? body.code.displayPrefix : body.plaintext.slice(0, 4),
      );
      await load();
    } catch (err: any) {
      setIssueError(err.message || "Failed to issue a code.");
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (codeId: string) => {
    setRevokingId(codeId);
    setError("");
    try {
      await apiJson(`${REFERRAL_CODE_BASE}/referral-codes/revoke`, {
        method: "POST",
        body: JSON.stringify({ codeId }),
      });
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to revoke the code.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div>
      <h3>Referral codes</h3>
      <p>
        Issue a code under this product&apos;s rule. The code value is shown once, in this session — copy
        it now; it is never stored and never shown again. Revoking a code never claws back runs already
        credited.
      </p>
      <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="referral">Referral (may attribute a referrer)</option>
        <option value="invite">Invite (never attributes)</option>
      </Select>
      <Select label="Issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)}>
        <option value="platform_admin">Platform admin (any tenant may redeem)</option>
        <option value="tenant_admin">Tenant admin (redeemable only in the named tenant)</option>
      </Select>
      {kind === "referral" && (
        <TextInput
          label="Referrer login (optional)"
          value={referrerUserId}
          onChange={(e) => setReferrerUserId(e.target.value)}
        />
      )}
      {issuer === "tenant_admin" && (
        <TextInput
          label="Tenant scope (required for tenant-admin issuance)"
          value={tenantScope}
          onChange={(e) => setTenantScope(e.target.value)}
        />
      )}
      <Button size="sm" loading={issuing} onClick={() => void issue()}>
        Issue code
      </Button>
      {issueError && <Notice tone="danger">{issueError}</Notice>}
      {issuedPlaintext && (
        <Notice tone="info">
          Code issued ({issuedPrefix}): {issuedPlaintext} — copy it now. This value is never shown again.
        </Notice>
      )}
      {loading && <p>Loading referral codes…</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!loading && !error && codes !== null && codes.length === 0 && <p>No codes issued for this product yet.</p>}
      {!loading &&
        !error &&
        codes !== null &&
        codes.map((code) => (
          <div key={code.id}>
            <div>
              <strong>{code.displayPrefix}</strong> · {code.kind} · issued by {code.issuerLogin} (
              {code.issuerKind}) · {code.runs} runs · {code.reusable ? "reusable" : "one-time"} ·{" "}
              {code.expiresAtMs === null ? "no expiry" : `expires ${formatDate(code.expiresAtMs)}`} ·{" "}
              {code.redemptionCount} redemptions
              {code.tenantScope ? ` · tenant ${code.tenantScope}` : ""}
              {code.referrerUserId ? ` · referrer ${code.referrerUserId}` : ""}
            </div>
            {code.revokedAtMs !== null ? (
              <div>Revoked {formatDate(code.revokedAtMs)}.</div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={revokingId === code.id}
                onClick={() => void revoke(code.id)}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
    </div>
  );
}

function ProductDetail({
  entry,
  onChanged,
  onNote,
}: {
  entry: ProductEntry;
  onChanged: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const { product, versions } = entry;
  const isFree = product.id === FREE_PRODUCT_ID;
  const groups = groupBySegment(versions);
  const segments = sortedSegments(groups.keys());
  const [segmentFilter, setSegmentFilter] = useState<string>("all");
  const [actionError, setActionError] = useState("");
  const [actingId, setActingId] = useState<string | null>(null);

  const visibleSegments = segmentFilter === "all" ? segments : segments.filter((s) => s === segmentFilter);

  const approve = async (version: ManageableVersionView) => {
    setActingId(version.id);
    setActionError("");
    try {
      await apiJson(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/versions/${encodeURIComponent(version.id)}/approve`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onNote(`Version v${version.version} (${version.segment}) approved.`);
      await onChanged();
    } catch (err: any) {
      setActionError(err.message || "Failed to approve version.");
    } finally {
      setActingId(null);
    }
  };

  const deactivate = async (version: ManageableVersionView) => {
    setActingId(version.id);
    setActionError("");
    try {
      await apiJson(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/versions/${encodeURIComponent(version.id)}/deactivate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      // A pack has no holders or period: deactivation blocks new
      // purchases only, and balances already bought are untouched.
      onNote(
        isRunsPackVersion(version)
          ? `Version v${version.version} (${version.segment}) deactivated. Pack balances already bought are untouched.`
          : `Version v${version.version} (${version.segment}) deactivated. Holders ride to period end.`,
      );
      await onChanged();
    } catch (err: any) {
      setActionError(err.message || "Failed to deactivate version.");
    } finally {
      setActingId(null);
    }
  };

  return (
    <Stack gap="2">
      {isFree && (
        <Notice tone="info">
          The Free baseline is read-only: it carries no versions and is never purchasable. The free-run allowance is
          managed in the Free Runs section.
        </Notice>
      )}
      {segments.length > 0 && (
        <Select
          label="Segment"
          value={segmentFilter}
          onChange={(e) => setSegmentFilter(e.target.value)}
          hint="Chains are per segment. A version sellable to one segment is invisible to another."
        >
          <option value="all">All segments</option>
          {segments.map((segment) => (
            <option key={segment} value={segment}>
              {segment}
            </option>
          ))}
        </Select>
      )}
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {versions.length === 0 && !isFree && <p>No versions yet. Create the first version below.</p>}
      {visibleSegments.map((segment) => {
        const chain = groups.get(segment) ?? [];
        const effective = resolveEffectiveVersion(chain, segment, Date.now());
        return (
          <div key={segment}>
            <h3>Segment: {segment}</h3>
            <Stack gap="1">
              {chain.map((version) => {
                const isEffective = effective?.id === version.id;
                const isFuture = version.effectiveFromMs > Date.now();
                const plan = isPlanVersion(version) ? version : null;
                const pack = isRunsPackVersion(version) ? version : null;
                const manageable = plan ?? pack;
                return (
                  <div key={version.id} data-testid={`version-row-${version.id}`}>
                    <Stack gap="1">
                      <div>
                        <strong>v{version.version}</strong> · {formatMoney(version.priceUSD)}
                        {isEffective && <span> · Current for this segment</span>}
                        {isFuture && <span> · Launches {formatDate(version.effectiveFromMs)}</span>}
                        {!isEffective && !isFuture && (
                          <span>
                            {" "}
                            · Effective {formatDate(version.effectiveFromMs)}
                            {version.effectiveToMs ? ` to ${formatDate(version.effectiveToMs)}` : ""}
                          </span>
                        )}
                      </div>
                      <div>
                        Approval: {version.approvalStatus}
                        {version.approvedBy ? ` by ${version.approvedBy}` : ""}
                        {version.approvedAtMs ? ` at ${formatDate(version.approvedAtMs)}` : ""}
                        {manageable && <> · {manageable.active ? "Active" : "Deactivated"}</>}
                      </div>
                      {plan && (
                        <div>
                          {plan.billingPeriod} · {plan.periodDays} days · {plan.includedRuns} included runs
                          {plan.trialDays !== null && <> · {plan.trialDays}-day trial</>}
                          {plan.stripePriceId && <> · Stripe Price {plan.stripePriceId}</>}
                        </div>
                      )}
                      {pack && (
                        <div>
                          {pack.runs} runs · No expiry · No tier · No subscription — buying adds the runs to the
                          buyer&apos;s pack balance.
                        </div>
                      )}
                      {plan && featuresOf(plan).length > 0 && (
                        <ul>
                          {featuresOf(plan).map((feature) => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                      )}
                      {!plan && !pack && (
                        <div>
                          Per-run price approval is managed in{" "}
                          <a href="?tab=payment-assurance">Payment assurance</a>. This section shows the status
                          only — it never approves a catalogue price.
                        </div>
                      )}
                      {manageable && (
                        <div>
                          {manageable.approvalStatus !== "approved" && (
                            <Button
                              size="sm"
                              loading={actingId === version.id}
                              onClick={() => void approve(manageable)}
                            >
                              Approve v{version.version}
                            </Button>
                          )}{" "}
                          {manageable.active && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={actingId === version.id}
                              onClick={() => void deactivate(manageable)}
                            >
                              Deactivate v{version.version}
                            </Button>
                          )}
                        </div>
                      )}
                    </Stack>
                  </div>
                );
              })}
            </Stack>
          </div>
        );
      })}
      {!isFree &&
        (product.kind === "subscription" ? (
          <NewVersionForm product={product} versions={versions} onCreated={onChanged} onNote={onNote} />
        ) : product.kind === "runs_pack" ? (
          <NewRunsPackVersionForm product={product} onCreated={onChanged} onNote={onNote} />
        ) : (
          <NewCatalogueVersionForm product={product} versions={versions} onCreated={onChanged} onNote={onNote} />
        ))}
      {!isFree && product.kind === "subscription" && (
        <BulkMovePanel product={product} versions={versions} onChanged={onChanged} />
      )}
      {!isFree && (
        <>
          <ReferralCodeRulesPanel productId={product.id} onChanged={onChanged} onNote={onNote} />
          <ReferralCodeManagementPanel productId={product.id} />
        </>
      )}
    </Stack>
  );
}

function parseNonNegativeInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

function parseEffectiveMs(value: string): number | null | typeof NaN {
  if (!value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function NewVersionForm({
  product,
  versions,
  onCreated,
  onNote,
}: {
  product: ProductRecord;
  versions: VersionView[];
  onCreated: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [price, setPrice] = useState("");
  const [periodDays, setPeriodDays] = useState("");
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "annual">("monthly");
  const [includedRuns, setIncludedRuns] = useState("");
  const [trialDays, setTrialDays] = useState("");
  const [features, setFeatures] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [segment, setSegment] = useState("");
  const [stripePriceId, setStripePriceId] = useState("");
  const [discountPct, setDiscountPct] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    apiJson<{ policy?: { annualDiscountPct?: number } }>("/api/payments/agentic/commercial/billing-policy")
      .then((body) => {
        if (!cancelled && typeof body?.policy?.annualDiscountPct === "number") {
          setDiscountPct(body.policy.annualDiscountPct);
        }
      })
      .catch(() => {
        // The suggestion is a convenience, never a gate: no
        // policy read, no suggestion — the form still works.
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  // §4.5: the annual suggestion is monthly × 12 × (1 − discount),
  // computed from the product's current monthly version for the
  // form's segment and the operator-set billing-policy discount.
  // It is a suggestion the operator may edit or ignore — never
  // an enforced price.
  const annualSuggestion = (() => {
    if (billingPeriod !== "annual" || discountPct === null) return null;
    const targetSegment = segment.trim() || DEFAULT_SEGMENT;
    const chain = versions.filter((v) => v.segment === targetSegment);
    const current = resolveEffectiveVersion(chain, targetSegment, Date.now());
    if (!current || !isPlanVersion(current) || current.billingPeriod !== "monthly") return null;
    return Math.round(current.priceUSD * 12 * (1 - discountPct / 100) * 100) / 100;
  })();

  const create = async () => {
    const priceUSD = Number(price);
    if (!Number.isFinite(priceUSD) || priceUSD < 0) {
      setFormError("Price must be a finite non-negative number.");
      return;
    }
    const period = Number(periodDays);
    if (!Number.isInteger(period) || period <= 0) {
      setFormError("Period must be a positive integer number of days.");
      return;
    }
    const runs = parseNonNegativeInt(includedRuns);
    if (runs === null || Number.isNaN(runs)) {
      setFormError("Included runs must be a non-negative integer.");
      return;
    }
    const trial = trialDays.trim() ? parseNonNegativeInt(trialDays) : null;
    if (Number.isNaN(trial)) {
      setFormError("Trial days must be a non-negative integer when present.");
      return;
    }
    const fromMs = parseEffectiveMs(effectiveFrom);
    if (Number.isNaN(fromMs)) {
      setFormError("Effective from must be a valid date when present.");
      return;
    }
    const toMs = parseEffectiveMs(effectiveTo);
    if (Number.isNaN(toMs) || (toMs !== null && fromMs !== null && toMs <= fromMs)) {
      setFormError("Effective to must be a valid date after effective from when present.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const body = await apiJson<{ plan: PlanVersionView }>(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            priceUSD,
            periodDays: period,
            includedRuns: runs,
            trialDays: trial,
            segment: segment.trim() || DEFAULT_SEGMENT,
            effectiveFromMs: fromMs,
            effectiveToMs: toMs,
            billingPeriod,
            features: features
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean),
            stripePriceId: stripePriceId.trim() || null,
          }),
        },
      );
      onNote(
        `Version v${body.plan.version} created for "${product.name}" (${body.plan.segment}). It lands proposed and moves no one — approve it to make it purchasable.`,
      );
      setShow(false);
      await onCreated();
    } catch (err: any) {
      setFormError(err.message || "Failed to create version.");
    } finally {
      setSaving(false);
    }
  };

  if (!show) {
    return (
      <div>
        <Button onClick={() => setShow(true)}>New version</Button>
      </div>
    );
  }
  return (
    <Stack gap="1">
      <h3>New version of {product.name}</h3>
      <p>
        A new version lands proposed and moves no one. Existing holders stay grandfathered; new customers buy the
        current effective version for their segment once this version is approved and effective.
      </p>
      <TextInput label="Price (USD)" value={price} onChange={(e) => setPrice(e.target.value)} />
      {annualSuggestion !== null && (
        <div>
          Annual suggestion from the current monthly price and the billing-policy discount ({discountPct}%):{" "}
          {formatMoney(annualSuggestion)}.{" "}
          <Button size="sm" variant="secondary" onClick={() => setPrice(String(annualSuggestion))}>
            Use suggestion
          </Button>
        </div>
      )}
      <TextInput label="Period (days)" value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} />
      <Select
        label="Billing period"
        value={billingPeriod}
        onChange={(e) => setBillingPeriod(e.target.value as "monthly" | "annual")}
      >
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
      </Select>
      <TextInput label="Included runs" value={includedRuns} onChange={(e) => setIncludedRuns(e.target.value)} />
      <TextInput
        label="Trial days (blank = none)"
        value={trialDays}
        onChange={(e) => setTrialDays(e.target.value)}
      />
      <TextInput
        label="Features (comma-separated, display only)"
        value={features}
        onChange={(e) => setFeatures(e.target.value)}
        hint="Features describe the version. They never gate behavior in this release."
      />
      <TextInput
        label="Effective from (blank = now)"
        type="datetime-local"
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
      />
      <TextInput
        label="Effective to (blank = open-ended)"
        type="datetime-local"
        value={effectiveTo}
        onChange={(e) => setEffectiveTo(e.target.value)}
      />
      <TextInput
        label="Segment (blank = default)"
        value={segment}
        onChange={(e) => setSegment(e.target.value)}
        hint="Free-form operator label. A version is sellable only to its own segment."
      />
      <TextInput
        label="Stripe Price id (blank = none)"
        value={stripePriceId}
        onChange={(e) => setStripePriceId(e.target.value)}
      />
      {formError && <Notice tone="danger">{formError}</Notice>}
      <div>
        <Button loading={saving} onClick={() => void create()}>
          Create version
        </Button>{" "}
        <Button variant="secondary" onClick={() => setShow(false)}>
          Cancel
        </Button>
      </div>
    </Stack>
  );
}

function NewCatalogueVersionForm({
  product,
  versions,
  onCreated,
  onNote,
}: {
  product: ProductRecord;
  versions: VersionView[];
  onCreated: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const family =
    (versions.find((v) => !isPlanVersion(v)) as CatalogueVersionView | undefined)?.family ??
    (PRICE_FAMILIES.includes(product.name as (typeof PRICE_FAMILIES)[number])
      ? product.name
      : null);
  const [show, setShow] = useState(false);
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [segment, setSegment] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  if (!family) {
    return <p>This per-run product has no catalogue family, so no catalogue version can be created for it.</p>;
  }

  const create = async () => {
    const priceUSD = Number(price);
    if (!Number.isFinite(priceUSD) || priceUSD < 0) {
      setFormError("Price must be a finite non-negative number.");
      return;
    }
    const fromMs = parseEffectiveMs(effectiveFrom);
    if (Number.isNaN(fromMs)) {
      setFormError("Effective from must be a valid date when present.");
      return;
    }
    const toMs = parseEffectiveMs(effectiveTo);
    if (Number.isNaN(toMs) || (toMs !== null && fromMs !== null && toMs <= fromMs)) {
      setFormError("Effective to must be a valid date after effective from when present.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const body = await apiJson<{ entry: CatalogueVersionView }>(
        "/api/payments/agentic/commercial/catalogue/versions",
        {
          method: "POST",
          body: JSON.stringify({
            family,
            priceUSD,
            segment: segment.trim() || DEFAULT_SEGMENT,
            effectiveFromMs: fromMs,
            effectiveToMs: toMs,
          }),
        },
      );
      onNote(
        `Catalogue version v${body.entry.version} created for "${product.name}" (${body.entry.segment}). It lands proposed — approve it in Payment assurance.`,
      );
      setShow(false);
      await onCreated();
    } catch (err: any) {
      setFormError(err.message || "Failed to create catalogue version.");
    } finally {
      setSaving(false);
    }
  };

  if (!show) {
    return (
      <div>
        <Button onClick={() => setShow(true)}>New catalogue version</Button>
      </div>
    );
  }
  return (
    <Stack gap="1">
      <h3>New catalogue version of {product.name}</h3>
      <p>
        A new catalogue version lands proposed. Per-run customers always pay their segment&apos;s current approved
        price — there is no move for per-run products. Approval is in{" "}
        <a href="?tab=payment-assurance">Payment assurance</a>.
      </p>
      <TextInput label="Price (USD)" value={price} onChange={(e) => setPrice(e.target.value)} />
      <TextInput
        label="Effective from (blank = now)"
        type="datetime-local"
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
      />
      <TextInput
        label="Effective to (blank = open-ended)"
        type="datetime-local"
        value={effectiveTo}
        onChange={(e) => setEffectiveTo(e.target.value)}
      />
      <TextInput
        label="Segment (blank = default)"
        value={segment}
        onChange={(e) => setSegment(e.target.value)}
        hint="Free-form operator label. A version is chargeable only to its own segment."
      />
      {formError && <Notice tone="danger">{formError}</Notice>}
      <div>
        <Button loading={saving} onClick={() => void create()}>
          Create catalogue version
        </Button>{" "}
        <Button variant="secondary" onClick={() => setShow(false)}>
          Cancel
        </Button>
      </div>
    </Stack>
  );
}

function BulkMovePanel({
  product,
  versions,
  onChanged,
}: {
  product: ProductRecord;
  versions: VersionView[];
  onChanged: () => Promise<void>;
}) {
  const versionsById = new Map(versions.map((v) => [v.id, v]));
  const segments = sortedSegments(new Set(versions.map((v) => v.segment)));
  const [scope, setScope] = useState<string>("all");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkMoveResult | null>(null);
  const [result, setResult] = useState<BulkMoveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [history, setHistory] = useState<BulkMoveRecord[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ bulkMove: BulkMoveRecord; moves: VersionMoveRecord[] } | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const body = await apiJson<{ bulkMoves: BulkMoveRecord[] }>(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/bulk-moves`,
      );
      setHistory(body.bulkMoves ?? []);
    } catch {
      // History is a convenience read; a failure leaves the
      // last-known list in place and never blocks a move.
    }
  }, [product.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const postBulkMove = async (body: Record<string, unknown>): Promise<BulkMoveResult> =>
    apiJson<BulkMoveResult>(`/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/bulk-move`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  const runPreview = async () => {
    if (!reason.trim()) {
      setPanelError("A reason is required: a bulk move is an explicit operator action with an audit trail.");
      return;
    }
    setBusy(true);
    setPanelError("");
    setResult(null);
    try {
      const previewResult = await postBulkMove({
        segmentScope: scope === "all" ? null : scope,
        reason: reason.trim(),
        dryRun: true,
      });
      setPreview(previewResult);
    } catch (err: any) {
      setPanelError(err.message || "Failed to preview the bulk move.");
    } finally {
      setBusy(false);
    }
  };

  const runMove = async (resumeBulkMoveId?: string) => {
    setBusy(true);
    setPanelError("");
    try {
      const moveResult = await postBulkMove({
        segmentScope: scope === "all" ? null : scope,
        reason: reason.trim(),
        ...(resumeBulkMoveId ? { resumeBulkMoveId } : {}),
      });
      setResult(moveResult);
      setPreview(null);
      await loadHistory();
      await onChanged();
    } catch (err: any) {
      setPanelError(err.message || "Failed to run the bulk move.");
    } finally {
      setBusy(false);
    }
  };

  const loadDetail = async (bulkMoveId: string) => {
    setDetailId(bulkMoveId);
    setDetail(null);
    try {
      const body = await apiJson<{ bulkMove: BulkMoveRecord; moves: VersionMoveRecord[] }>(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/bulk-moves/${encodeURIComponent(bulkMoveId)}`,
      );
      setDetail(body);
    } catch (err: any) {
      setPanelError(err.message || "Failed to load the bulk-move detail.");
    }
  };

  const movableIn = (segmentPreview: BulkMovePreviewSegment): number => {
    if (!segmentPreview.targetReady || !segmentPreview.targetVersionId) return 0;
    const already = segmentPreview.fromVersions.find((f) => f.versionId === segmentPreview.targetVersionId)?.count ?? 0;
    return segmentPreview.holderCount - already;
  };
  const totalMovable = preview ? preview.preview.reduce((sum, s) => sum + movableIn(s), 0) : 0;

  return (
    <Stack gap="1">
      <h3>Move all customers to current pricing</h3>
      <p>
        Every live holder of a non-current version of this product moves to their own segment&apos;s current effective
        version. Holders already on the current version are skipped. Per-run customers are untouched — they always
        pay their segment&apos;s current price. A move never changes runs or credits, and the current paid period
        runs to its end on the old terms.
      </p>
      <Select
        label="Segment scope"
        value={scope}
        onChange={(e) => {
          setScope(e.target.value);
          setPreview(null);
        }}
        hint="All segments moves every live holder of this product. Narrowing to one segment moves only its holders."
      >
        <option value="all">All segments</option>
        {segments.map((segment) => (
          <option key={segment} value={segment}>
            {segment}
          </option>
        ))}
      </Select>
      <TextInput
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint="Recorded on the bulk-move summary and every per-customer move row."
      />
      {panelError && <Notice tone="danger">{panelError}</Notice>}
      <div>
        <Button loading={busy} onClick={() => void runPreview()}>
          Preview move
        </Button>
      </div>
      {preview && (
        <Stack gap="1">
          <h4>Confirmation — no one has moved yet</h4>
          {preview.preview.length === 0 && <p>No live holders of this product in scope.</p>}
          {preview.preview.map((segmentPreview) => {
            const target = segmentPreview.targetVersionId
              ? versionsById.get(segmentPreview.targetVersionId)
              : undefined;
            return (
              <div key={segmentPreview.segment}>
                <div>
                  <strong>{segmentPreview.segment}</strong> · {segmentPreview.holderCount} holder
                  {segmentPreview.holderCount === 1 ? "" : "s"}
                </div>
                {segmentPreview.targetReady ? (
                  <div>
                    Target: {versionLabel(target)} · {movableIn(segmentPreview)} will move,{" "}
                    {segmentPreview.holderCount - movableIn(segmentPreview)} already on the current version.
                  </div>
                ) : segmentPreview.targetVersionId ? (
                  <div>
                    Target {versionLabel(target)} is not approved or not active — these holders stay put. Approve the
                    version first to move them.
                  </div>
                ) : (
                  <div>No effective version for this segment — these holders stay put.</div>
                )}
                <div>
                  From:{" "}
                  {segmentPreview.fromVersions
                    .map((from) => `${versionLabel(versionsById.get(from.versionId))} (${from.count})`)
                    .join(", ")}
                </div>
              </div>
            );
          })}
          <div>
            <Button loading={busy} disabled={totalMovable === 0} onClick={() => void runMove()}>
              Move {totalMovable} holder{totalMovable === 1 ? "" : "s"} to current pricing
            </Button>{" "}
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </Stack>
      )}
      {result && result.bulkMove && (
        <Stack gap="1">
          <Notice tone={result.failedCount > 0 ? "warning" : "success"}>
            {result.bulkMove.status === "running"
              ? `Bulk move ${result.bulkMove.id} is still running: ${result.movedCount} moved, ${result.skippedCount} skipped, ${result.failedCount} failed in this pass. ${result.hasMore ? "More holders remain — resume to continue." : ""}`
              : `Bulk move ${result.bulkMove.id} ${result.bulkMove.status.replaceAll("_", " ")}: ${result.bulkMove.movedCount} moved, ${result.bulkMove.skippedCount} skipped, ${result.bulkMove.failedCount} failed.`}
          </Notice>
          {result.hasMore && (
            <div>
              <Button loading={busy} onClick={() => void runMove(result.bulkMove!.id)}>
                Resume bulk move
              </Button>
            </div>
          )}
          {result.failures.length > 0 && (
            <div>
              <h4>Failures (recorded, never fatal)</h4>
              <ul>
                {result.failures.map((failure) => (
                  <li key={failure.subscriptionId}>
                    {failure.userId}: {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Stack>
      )}
      {history.length > 0 && (
        <div>
          <h4>Bulk-move history</h4>
          <Stack gap="1">
            {history.map((summary) => (
              <div key={summary.id}>
                <div>
                  {summary.id} · {summary.status.replaceAll("_", " ")} · {summary.movedCount} moved,{" "}
                  {summary.skippedCount} skipped, {summary.failedCount} failed · by {summary.movedBy} ·{" "}
                  {formatDate(summary.startedAtMs)}
                  {summary.reason ? ` · ${summary.reason}` : ""}
                </div>
                <div>
                  <Button size="sm" variant="secondary" onClick={() => void loadDetail(summary.id)}>
                    {detailId === summary.id ? "Hide per-customer moves" : "Show per-customer moves"}
                  </Button>{" "}
                  {summary.status === "running" && (
                    <Button size="sm" onClick={() => void runMove(summary.id)}>
                      Resume
                    </Button>
                  )}
                </div>
                {detailId === summary.id && detail && (
                  <ul>
                    {detail.moves.length === 0 && <li>No per-customer moves recorded yet.</li>}
                    {detail.moves.map((move) => (
                      <li key={move.id}>
                        {move.userId} ({move.segment}): {versionLabel(versionsById.get(move.fromVersionId ?? ""))} →{" "}
                        {versionLabel(versionsById.get(move.toVersionId ?? ""))} · by {move.movedBy} ·{" "}
                        {formatDate(move.movedAtMs)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/**
 * Issue #3246 slice 3 — new runs-pack version form. A pack version
 * is (runs, price) only: no plan fields, no billing period, no
 * trial, no expiry. It lands proposed and moves no one; approve
 * it here to make it purchasable. Buying a pack never confers a
 * tier and never creates a subscription row.
 */
function NewRunsPackVersionForm({
  product,
  onCreated,
  onNote,
}: {
  product: ProductRecord;
  onCreated: () => Promise<void>;
  onNote: (note: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [runs, setRuns] = useState("");
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [segment, setSegment] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const create = async () => {
    const runsValue = parseNonNegativeInt(runs);
    if (runsValue === null || Number.isNaN(runsValue) || runsValue <= 0) {
      setFormError("Runs must be a positive integer.");
      return;
    }
    const priceUSD = Number(price);
    if (!Number.isFinite(priceUSD) || priceUSD < 0) {
      setFormError("Price must be a finite non-negative number.");
      return;
    }
    const fromMs = parseEffectiveMs(effectiveFrom);
    if (Number.isNaN(fromMs)) {
      setFormError("Effective from must be a valid date when present.");
      return;
    }
    const toMs = parseEffectiveMs(effectiveTo);
    if (Number.isNaN(toMs) || (toMs !== null && fromMs !== null && toMs <= fromMs)) {
      setFormError("Effective to must be a valid date after effective from when present.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const body = await apiJson<{ version: RunsPackVersionView }>(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            runs: runsValue,
            priceUSD,
            segment: segment.trim() || DEFAULT_SEGMENT,
            effectiveFromMs: fromMs,
            effectiveToMs: toMs,
          }),
        },
      );
      onNote(
        `Pack version v${body.version.version} created for "${product.name}" (${body.version.segment}): ${body.version.runs} runs for ${formatMoney(body.version.priceUSD)}. It lands proposed — approve it to make it purchasable.`,
      );
      setShow(false);
      await onCreated();
    } catch (err: any) {
      setFormError(err.message || "Failed to create pack version.");
    } finally {
      setSaving(false);
    }
  };

  if (!show) {
    return (
      <div>
        <Button onClick={() => setShow(true)}>New pack version</Button>
      </div>
    );
  }
  return (
    <Stack gap="1">
      <h3>New pack version of {product.name}</h3>
      <p>
        A new pack version lands proposed and moves no one. Buying a pack adds its runs to the buyer&apos;s pack
        balance — it never confers a tier and never creates a subscription row. Pack runs never expire.
      </p>
      <TextInput label="Runs" value={runs} onChange={(e) => setRuns(e.target.value)} />
      <TextInput label="Price (USD)" value={price} onChange={(e) => setPrice(e.target.value)} />
      <TextInput
        label="Effective from (blank = now)"
        type="datetime-local"
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
      />
      <TextInput
        label="Effective to (blank = open-ended)"
        type="datetime-local"
        value={effectiveTo}
        onChange={(e) => setEffectiveTo(e.target.value)}
      />
      <TextInput
        label="Segment (blank = default)"
        value={segment}
        onChange={(e) => setSegment(e.target.value)}
        hint="Free-form operator label. A version is sellable only to its own segment."
      />
      {formError && <Notice tone="danger">{formError}</Notice>}
      <div>
        <Button loading={saving} onClick={() => void create()}>
          Create pack version
        </Button>{" "}
        <Button variant="secondary" onClick={() => setShow(false)}>
          Cancel
        </Button>
      </div>
    </Stack>
  );
}
