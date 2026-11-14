/**
 * Product Hub (issue #4530) — the page behind ?tab=product-hub.
 *
 * The hub is the ONLY place for product-domain URLs: the standalone
 * products page and the platform-admin products / free-runs sections
 * moved into it (their old addresses redirect — see
 * legacyProductRedirect in ./router). Billing, Checkout, Payments,
 * Orders, Ledger, and Revenue stay standalone and are NOT hub tabs.
 *
 * Four tabs, URL-synced on "view" via the shared useUrlSyncedTabs
 * hook + the Tabs/TabPanel primitives, following the StockHub /
 * OptionsHub pattern: panels mount on first visit and stay preserved
 * in the DOM (visitedTabs gating). The panels are reused, not
 * rebuilt: ProductCatalogPanel, the exported SellingSection,
 * ProductsSection, FreeRunAllowanceSection.
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
  Tabs,
  TabPanel,
  type TabOption,
} from "./components/ui";
import { ProductCatalogPanel, SellingSection } from "./ProductCatalogPanel";
import { ProductsSection } from "./ProductsSection";
import { FreeRunAllowanceSection } from "./FreeRunAllowanceSection";
import type { CatalogDisplayEntry } from "../data/productMarketing";

export type ProductHubTab =
  | "products"
  | "selling-options"
  | "admin-products"
  | "free-runs";

export const PRODUCT_HUB_TABS: readonly ProductHubTab[] = [
  "products",
  "selling-options",
  "admin-products",
  "free-runs",
] as const;

export function isValidProductHubTab(tab: unknown): tab is ProductHubTab {
  return (
    typeof tab === "string" &&
    (PRODUCT_HUB_TABS as readonly string[]).includes(tab)
  );
}

const PRODUCT_HUB_TAB_OPTIONS: TabOption<ProductHubTab>[] = [
  { id: "products", label: "Products" },
  { id: "selling-options", label: "Selling options" },
  { id: "admin-products", label: "Admin Products" },
  { id: "free-runs", label: "Free Runs" },
];

export function ProductHub() {
  const { activeTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<ProductHubTab>({
      param: "view",
      isValid: isValidProductHubTab,
      defaultTab: "products",
    });

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

  return (
    <PageTemplate
      title="Product Hub"
      scopeNote="The product catalog, selling options, product and version configuration, and free-run allowances — one hub."
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

      {/* Tabbed panels — mount on first visit, stay preserved. */}

      {visitedTabs.has("products") && (
        <TabPanel
          idBase="product-hub"
          tabId="products"
          active={activeTab === "products"}
          retain
        >
          <ErrorBoundary label="Products panel">
            <ProductCatalogPanel />
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

      {visitedTabs.has("admin-products") && (
        <TabPanel
          idBase="product-hub"
          tabId="admin-products"
          active={activeTab === "admin-products"}
          retain
        >
          <ErrorBoundary label="Admin Products panel">
            <ProductsSection />
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
    </PageTemplate>
  );
}
