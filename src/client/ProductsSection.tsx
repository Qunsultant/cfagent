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
 * keyed by product id and land with #3307; this section
 * carries only the placement note, no referral mechanics.
 *
 * Operator-only: every route returns 403 for a non-operator.
 * All data is operator data — no hardcoded prices, dates, or
 * rules anywhere in this file.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Select, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";
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

export type VersionView = PlanVersionView | CatalogueVersionView;

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

export function ProductsSection() {
  const [entries, setEntries] = useState<ProductEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"subscription" | "per_run">("subscription");
  const [newDescription, setNewDescription] = useState("");
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
    setCreating(true);
    setCreateError("");
    try {
      await apiJson("/api/payments/agentic/commercial/products", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          kind: newKind,
          description: newDescription.trim() ? newDescription.trim() : null,
        }),
      });
      setNewName("");
      setNewDescription("");
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
                      <span>{product.kind === "subscription" ? "Subscription" : "Per-run"}</span>{" "}
                      {isFree && <span>· Read-only baseline</span>}
                      {product.description && <div>{product.description}</div>}
                      <div>
                        {versions.length} version{versions.length === 1 ? "" : "s"}
                        {currentSummary ? ` — current: ${currentSummary}` : ""}
                      </div>
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
              <Select label="Kind" value={newKind} onChange={(e) => setNewKind(e.target.value as "subscription" | "per_run")}>
                <option value="subscription">Subscription</option>
                <option value="per_run">Per-run</option>
              </Select>
              <TextInput
                label="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
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

  const approve = async (version: PlanVersionView) => {
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

  const deactivate = async (version: PlanVersionView) => {
    setActingId(version.id);
    setActionError("");
    try {
      await apiJson(
        `/api/payments/agentic/commercial/products/${encodeURIComponent(product.id)}/versions/${encodeURIComponent(version.id)}/deactivate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onNote(`Version v${version.version} (${version.segment}) deactivated. Holders ride to period end.`);
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
                        {plan && <> · {plan.active ? "Active" : "Deactivated"}</>}
                      </div>
                      {plan && (
                        <div>
                          {plan.billingPeriod} · {plan.periodDays} days · {plan.includedRuns} included runs
                          {plan.trialDays !== null && <> · {plan.trialDays}-day trial</>}
                          {plan.stripePriceId && <> · Stripe Price {plan.stripePriceId}</>}
                        </div>
                      )}
                      {plan && featuresOf(plan).length > 0 && (
                        <ul>
                          {featuresOf(plan).map((feature) => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                      )}
                      {!plan && (
                        <div>
                          Per-run price approval is managed in{" "}
                          <a href="?tab=payment-assurance">Payment assurance</a>. This section shows the status
                          only — it never approves a catalogue price.
                        </div>
                      )}
                      {plan && (
                        <div>
                          {plan.approvalStatus !== "approved" && (
                            <Button
                              size="sm"
                              loading={actingId === version.id}
                              onClick={() => void approve(plan)}
                            >
                              Approve v{version.version}
                            </Button>
                          )}{" "}
                          {plan.active && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={actingId === version.id}
                              onClick={() => void deactivate(plan)}
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
        ) : (
          <NewCatalogueVersionForm product={product} versions={versions} onCreated={onChanged} onNote={onNote} />
        ))}
      {!isFree && product.kind === "subscription" && (
        <BulkMovePanel product={product} versions={versions} onChanged={onChanged} />
      )}
      <div>
        Referral codes for this product are configured with issue #3307: rules are keyed by this product id and
        survive version changes. No referral mechanics live in this section.
      </div>
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
