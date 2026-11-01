/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 *
 * The first surface that renders the Phase 2 product catalog:
 * a read-only panel over GET /api/products/catalog. Prices are
 * shown only when approved (the route derives them from the
 * catalog; this panel never invents one), parity verdicts are
 * shown exactly as Phase 3 recorded them, and unlisted products
 * render with their reasons, never hidden silently.
 *
 * The draft preview composes (never publishes) a marketing draft
 * for a listed row from the Phase 2 naming registry. Preview is
 * composition only: no draft is stored, sent, or posted, and the
 * preview states that publishing requires owner approval.
 * No ads are served from this panel (ads enforcement is #2658).
 */
import React, { useEffect, useState } from "react";
import { Badge } from "./components/ui/Badge";
import { FieldShell } from "./components/ui/Field";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { PageSection, PageShell } from "./components/ui/PageShell";
import { Select } from "./components/ui/Select";
import { Table, type TableColumn } from "./components/ui/Table";
import {
  composeMarketingDraft,
  TEASER_CANDIDATE_CAP,
  type CatalogDisplayEntry,
  type MarketingChannel,
  type MarketingDraft,
} from "../data/productMarketing";

function availabilityTone(
  availability: CatalogDisplayEntry["availability"],
): "success" | "neutral" {
  return availability === "purchasable" ? "success" : "neutral";
}

function parityTone(
  verdict: CatalogDisplayEntry["parityVerdict"],
): "success" | "neutral" {
  return verdict === "parity" ? "success" : "neutral";
}

export function ProductCatalogPanel() {
  const [products, setProducts] = useState<CatalogDisplayEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<MarketingChannel>("facebook");
  const [preview, setPreview] = useState<MarketingDraft | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/products/catalog")
      .then(async (res) => {
        if (!res.ok) throw new Error(`catalog request failed: ${res.status}`);
        const body = (await res.json()) as { products: CatalogDisplayEntry[] };
        if (!cancelled) setProducts(body.products);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "catalog request failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columns: TableColumn<CatalogDisplayEntry>[] = [
    { key: "product", header: "Product", render: (row) => row.canonicalName },
    { key: "tier", header: "Tier", render: (row) => row.tier },
    {
      key: "price",
      header: "Price",
      render: (row) => row.priceLabel ?? "—",
    },
    {
      key: "availability",
      header: "Availability",
      render: (row) => (
        <Badge tone={availabilityTone(row.availability)}>{row.availability}</Badge>
      ),
    },
    {
      key: "parity",
      header: "Parity",
      render: (row) => (
        <Badge tone={parityTone(row.parityVerdict)}>
          {row.parityVerdict ?? "unknown"}
        </Badge>
      ),
    },
    {
      key: "purchase",
      header: "Purchase path",
      render: (row) =>
        row.purchasePath ? (
          <a href={row.purchasePath.route}>{row.purchasePath.label}</a>
        ) : (
          (row.purchasePathReason ?? row.unlistedReasons.join("; "))
        ),
    },
    {
      key: "draft",
      header: "Draft preview",
      render: (row) =>
        row.listed ? (
          <Button
            variant="secondary"
            onClick={() => {
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
                    channel,
                  ),
                );
              } catch (err) {
                setPreview(null);
                setPreviewError(
                  err instanceof Error ? err.message : "draft composition failed",
                );
              }
            }}
          >
            Preview draft
          </Button>
        ) : (
          row.unlistedReasons.join("; ")
        ),
    },
  ];

  return (
    <PageShell
      title="Products"
      scopeNote="The product catalog as the Phase 2 registry records it, with Phase 3 access parity. Prices shown are approved prices only."
      loading={products === null && error === null}
      loadingLabel="Loading catalog"
      error={error}
      empty={products !== null && products.length === 0}
      emptyTitle="No products registered"
      emptyDescription="The catalog has no entries yet."
    >
      <PageSection title="Catalog">
        <Table
          columns={columns}
          rows={products ?? []}
          rowKey={(row) => row.id}
          caption="Product catalog"
        />
      </PageSection>
      <PageSection
        title="Teaser rules"
        description="How limited teasers are built (teaser rule B1, issue 1076)."
      >
        <Card>
          <p>
            Teasers show at most {TEASER_CANDIDATE_CAP} candidates from the
            same screening pipeline and gates. Only gate-passing candidates
            with stated falsification criteria are shown; every entry is
            labeled as a teaser, never as a recommendation. Links appear
            only when the caller supplies them — a teaser never promises
            a report, subscription, or referral-credit path that does not
            exist.
          </p>
        </Card>
      </PageSection>
      <PageSection title="Marketing draft preview">
        <FieldShell id="marketing-channel" label="Channel">
          <Select
            id="marketing-channel"
            aria-label="Marketing channel"
            value={channel}
            onChange={(event) =>
              setChannel(event.target.value as MarketingChannel)
            }
          >
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="threads">Threads</option>
            <option value="slack">Slack</option>
          </Select>
        </FieldShell>
        {previewError && <p>{previewError}</p>}
        {preview && (
          <Card>
            <p>{preview.text}</p>
            <p>
              Draft only — not published. Publishing requires owner
              approval.
            </p>
            {preview.citationOmittedReason && (
              <p>Citation omitted: {preview.citationOmittedReason}</p>
            )}
            {preview.truncated && <p>Draft truncated to the channel limit.</p>}
          </Card>
        )}
      </PageSection>
    </PageShell>
  );
}
