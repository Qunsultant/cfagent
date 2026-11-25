/**
 * Product Hub (issue #4530) — the page behind ?tab=product-hub.
 *
 * The hub is the ONLY place for product-domain URLs: the standalone
 * products page and the platform-admin products / free-runs sections
 * moved into it (their old addresses redirect — see
 * legacyProductRedirect in ./router). Billing, Checkout, Payments,
 * Orders, Ledger, and Revenue stay standalone and are NOT hub tabs.
 *
 * Five tabs, URL-synced on "view" via the shared useUrlSyncedTabs
 * hook + the Tabs/TabPanel primitives, following the StockHub /
 * OptionsHub pattern: panels mount on first visit and stay preserved
 * in the DOM (visitedTabs gating). The panels are reused, not
 * rebuilt: ProductCatalogPanel, the exported SellingSection,
 * MarketingDraftPreviewSection, ProductsSection,
 * FreeRunAllowanceSection.
 *
 * Issue #4582 — just one of everything: the Products tab shows the
 * catalog directly (no sub-tab row), Selling options is a hub tab
 * only, and Marketing draft preview is a hub tab of its own (its
 * composition state lives here in the hub; the catalog's Preview
 * draft button composes and switches to it).
 *
 * The hub tab IS the demand for the selling load: visiting the
 * Selling options tab opens the selling flow (the Products page
 * keeps its own on-demand button contract). The hub fetches the
 * catalog once for the Selling tab's products prop — the Products
 * tab's panel keeps its own copy, so the catalog is read twice when
 * the Selling tab is first visited (accepted duplicate: the two
 * panels own separate state and cannot share one read).
 */
import { useEffect, useRef, useState } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  PageSection,
  PageTemplate,
  KpiRibbon,
  Tabs,
  TabPanel,
  type TabOption,
} from "./components/ui";
import { PageChromeContext } from "./components/ui/PageShell";
import {
  ProductCatalogPanel,
  MarketingDraftPreviewSection,
  SellingSection,
} from "./ProductCatalogPanel";
import { ProductsSection } from "./ProductsSection";
import { PriceCatalogueSection } from "./PriceCatalogueSection";
import { FreeRunAllowanceSection } from "./FreeRunAllowanceSection";
import {
  composeMarketingDraft,
  type CatalogDisplayEntry,
  type MarketingChannel,
  type MarketingDraft,
} from "../data/productMarketing";

export type ProductHubTab =
  | "products"
  | "selling-options"
  | "marketing-draft-preview"
  | "admin-products"
  | "free-runs";

export const PRODUCT_HUB_TABS: readonly ProductHubTab[] = [
  "products",
  "selling-options",
  "marketing-draft-preview",
  "admin-products",
  "free-runs",
] as const;

export function isValidProductHubTab(tab: unknown): tab is ProductHubTab {
  return (
    typeof tab === "string" &&
    (PRODUCT_HUB_TABS as readonly string[]).includes(tab)
  );
}

export const PRODUCT_HUB_TAB_OPTIONS: TabOption<ProductHubTab>[] = [
  { id: "products", label: "Products" },
  { id: "selling-options", label: "Selling options" },
  { id: "marketing-draft-preview", label: "Marketing draft preview" },
  { id: "admin-products", label: "Admin Products" },
  { id: "free-runs", label: "Free Runs" },
];

export function ProductHub() {
  const { activeTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<ProductHubTab>({
      param: "view",
      isValid: isValidProductHubTab,
      defaultTab: "products",
      // Issue #4689 — the Admin Products section's nested `adminTab`
      // param belongs to admin-products only. The hook calls this
      // BEFORE its own pushState, so the strip (replaceState) lands
      // first and the push keeps a clean URL when the hub tab moves
      // away — the #4582 leak, where the old nested `productTab`
      // persisted across hub tabs, does not recur.
      onTabChange: (nextTab) => {
        if (nextTab !== "admin-products" && typeof window !== "undefined") {
          try {
            const url = new URL(window.location.href);
            if (url.searchParams.has("adminTab")) {
              url.searchParams.delete("adminTab");
              window.history.replaceState(null, "", url.toString());
            }
          } catch {
            // Safe fallback for environments with restricted history
          }
        }
      },
    });

  // Issue #4825 — the hub's kpiRibbon slot: the catalog size, reported
  // up by the Products tab's panel when its catalog loads (no second
  // read — the panel's own fetch reports the counts). The ribbon stays
  // empty until the first load reports; KpiRibbon renders nothing
  // with no items.
  const [catalogStats, setCatalogStats] = useState<{
    total: number;
    listed: number;
  } | null>(null);

  // Selling tab state: the products prop for the SellingSection (lazy
  // catalog read, once) and the open signal (bumped on every visit;
  // the section's own loaded guard makes re-bumps a no-op after a
  // successful load, and a retry after a failed one).
  const [sellingProducts, setSellingProducts] = useState<
    CatalogDisplayEntry[] | null
  >(null);
  const [sellingOpenRequest, setSellingOpenRequest] = useState(0);
  const sellingCatalogFetchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "selling-options") return;
    setSellingOpenRequest((n) => n + 1);
    if (sellingCatalogFetchedRef.current) return;
    sellingCatalogFetchedRef.current = true;
    fetch("/api/products/catalog")
      .then(async (res) => {
        if (!res.ok) throw new Error(`catalog request failed: ${res.status}`);
        const body = (await res.json()) as { products: CatalogDisplayEntry[] };
        if (mountedRef.current) setSellingProducts(body.products);
      })
      .catch(() => {
        // A failed read retries on the next visit.
        sellingCatalogFetchedRef.current = false;
      });
  }, [activeTab]);

  // Marketing draft preview state (#4582): the hub owns the
  // composition (channel / preview / error); the catalog's Preview
  // draft button composes and switches the hub to this tab.
  const [previewChannel, setPreviewChannel] = useState<MarketingChannel>("facebook");
  const [preview, setPreview] = useState<MarketingDraft | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function handlePreviewDraft(row: CatalogDisplayEntry) {
    try {
      setPreviewError(null);
      setPreview(
        composeMarketingDraft(
          {
            id: row.id,
            canonicalName: row.canonicalName,
            priceUSD: row.priceUSD,
            listed: row.listed,
            unlistedReasons: row.unlistedReasons,
          },
          previewChannel,
        ),
      );
    } catch (err) {
      setPreview(null);
      setPreviewError(
        err instanceof Error ? err.message : "draft composition failed",
      );
    }
    handleTabChange("marketing-draft-preview");
  }

  function handleSubscribe() {
    // The hub's selling load opens on tab visit (see the effect below).
    handleTabChange("selling-options");
  }

  return (
    <PageTemplate
      title="Product Hub"
      scopeNote="The product catalog, selling options, marketing draft previews, product and version configuration, and free-run allowances — one hub."
      kpiRibbon={
        catalogStats ? (
          <KpiRibbon
            items={[
              { label: "Products", value: String(catalogStats.total) },
              { label: "Listed", value: String(catalogStats.listed) },
            ]}
          />
        ) : undefined
      }
    >
      <PageSection>
        <Tabs<ProductHubTab>
          idBase="product-hub"
          ariaLabel="Product Hub sections"
          tabs={PRODUCT_HUB_TAB_OPTIONS}
          value={activeTab}
          onChange={handleTabChange}
        />
      </PageSection>

      {/* Tabbed panels — mount on first visit, stay preserved.
          The panels render under "tab" chrome (the #4167 host pattern):
          ProductCatalogPanel renders its own PageShell, and without the
          host context the page would carry a second h1 ("Products") next
          to the hub's own ("Product Hub"). Under "tab" the panel's shell
          collapses to body-only; the panel itself is never edited for
          the host it lands in. */}
      <PageChromeContext.Provider value="tab">
      {visitedTabs.has("products") && (
        <TabPanel
          idBase="product-hub"
          tabId="products"
          active={activeTab === "products"}
          retain
        >
          <ErrorBoundary label="Products panel">
            <ProductCatalogPanel
              onSubscribe={handleSubscribe}
              onPreviewDraft={handlePreviewDraft}
              onCatalogStats={setCatalogStats}
            />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("selling-options") && (
        <TabPanel
          idBase="product-hub"
          tabId="selling-options"
          active={activeTab === "selling-options"}
          retain
        >
          <ErrorBoundary label="Selling options panel">
            <SellingSection
              products={sellingProducts}
              openSignal={sellingOpenRequest}
            />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("marketing-draft-preview") && (
        <TabPanel
          idBase="product-hub"
          tabId="marketing-draft-preview"
          active={activeTab === "marketing-draft-preview"}
          retain
        >
          <ErrorBoundary label="Marketing draft preview panel">
            <MarketingDraftPreviewSection
              channel={previewChannel}
              preview={preview}
              previewError={previewError}
              onChannelChange={setPreviewChannel}
            />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("admin-products") && (
        <TabPanel
          idBase="product-hub"
          tabId="admin-products"
          active={activeTab === "admin-products"}
          retain
        >
          <ErrorBoundary label="Admin Products panel">
            <ProductsSection isActive={activeTab === "admin-products"} />
          </ErrorBoundary>
          <ErrorBoundary label="Per-run prices panel">
            <PriceCatalogueSection />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("free-runs") && (
        <TabPanel
          idBase="product-hub"
          tabId="free-runs"
          active={activeTab === "free-runs"}
          retain
        >
          <ErrorBoundary label="Free Runs panel">
            <FreeRunAllowanceSection />
          </ErrorBoundary>
        </TabPanel>
      )}
      </PageChromeContext.Provider>
    </PageTemplate>
  );
}
