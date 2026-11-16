import React, { useState } from "react";
import { Button, Card, CardHeader, Notice, Modal, PillGroup } from "./ui";

export interface PartnerDeal {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge?: string;
  url: string;
  ctaText?: string;
  accentColor?: string;
  category?: string;
}

export interface PartnerDealsModalProps {
  isOpen: boolean;
  onClose: () => void;
  ads?: any[];
  externalAds?: any[];
  onAdClick?: (ad: any) => void;
  onExternalAdClick?: (ad: any) => void;
}

const DEFAULT_PARTNER_DEALS: PartnerDeal[] = [
  {
    id: "ad_workers_ai",
    title: "Neural Strategy Accelerators",
    tagline: "Deploy state-of-the-art models (GLM-4.7, Llama 3.3) on dedicated high-throughput inference nodes with zero cold starts.",
    sponsor: "Enterprise Neural Compute",
    badge: "FLAGSHIP PARTNER",
    url: "https://agent.openaimp.com/docs",
    ctaText: "Explore Models →",
    accentColor: "var(--color-warning)",
    category: "AI & Intelligence",
  },
  {
    id: "ad_ai_search",
    title: "Enterprise Vector Knowledge Engine",
    tagline: "Build institutional knowledge pipelines with native auto-chunking, dense embeddings, and real-time semantic retrieval.",
    sponsor: "Enterprise Intelligence Network",
    badge: "FEATURED TOOL",
    url: "https://agent.openaimp.com/docs",
    ctaText: "Explore Docs →",
    accentColor: "var(--color-accent)",
    category: "AI & Intelligence",
  },
  {
    id: "ad_durable_objects",
    title: "Distributed Transactional Ledger",
    tagline: "Strongly consistent transactional state machine with write-ahead logging for mission-critical trading agents.",
    sponsor: "Enterprise State Architecture",
    badge: "INFRASTRUCTURE",
    url: "https://agent.openaimp.com/docs",
    ctaText: "Learn More →",
    accentColor: "var(--color-sentiment-directional)",
    category: "Infrastructure",
  },
  {
    id: "g_ad_vertex",
    title: "Google Cloud Vertex AI & TPU v5e",
    tagline: "Build, deploy, and scale enterprise multimodal AI models with sub-second latency and $300 in free trial credits.",
    sponsor: "Google Cloud",
    badge: "CLOUD CREDITS",
    url: "https://cloud.google.com/vertex-ai",
    ctaText: "Start Free with $300 →",
    accentColor: "var(--color-accent)",
    category: "Cloud Platforms",
  },
  {
    id: "g_ad_bigquery",
    title: "Google BigQuery Serverless Analytics",
    tagline: "Query petabytes of analytics data in seconds without managing servers or storage infrastructure.",
    sponsor: "Google Cloud Data",
    badge: "ANALYTICS",
    url: "https://cloud.google.com/bigquery",
    ctaText: "Explore BigQuery Studio →",
    accentColor: "var(--color-success)",
    category: "Analytics & Data",
  },
];

export function PartnerDealsModal({
  isOpen,
  onClose,
  ads = [],
  externalAds = [],
  onAdClick,
  onExternalAdClick,
}: PartnerDealsModalProps) {
  const [filterCategory, setFilterCategory] = useState<string>("All");

  // Merge runtime ads with defaults to present comprehensive external deals showcase
  const combinedDeals: PartnerDeal[] = [
    ...ads.map((a) => ({
      id: a.id || `ad_${Math.random()}`,
      title: a.title,
      tagline: a.tagline,
      sponsor: a.sponsor || "Partner",
      badge: a.badge || "SPONSOR",
      url: a.url,
      ctaText: a.ctaText || "View Offer →",
      accentColor: a.accentColor || "var(--color-accent)",
      category: "Direct Partner",
    })),
    ...DEFAULT_PARTNER_DEALS.filter((d) => !ads.some((a) => a.id === d.id)),
  ];

  const categories = ["All", ...Array.from(new Set(combinedDeals.map((d) => d.category || "General")))];
  const filteredDeals = filterCategory === "All"
    ? combinedDeals
    : combinedDeals.filter((d) => d.category === filterCategory);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="none"
      panelClassName="partner-deals-modal-card"
  footer={
    <div className="partner-deals-footer">
      <span className="deals-counter">Showing {filteredDeals.length} partner offer{filteredDeals.length === 1 ? "" : "s"}</span>
      <Button className="partner-deals-dismiss-btn" onClick={onClose}>
        Back to Workspace
      </Button>
    </div>
  }
      title={
        <div className="partner-deals-title-area">
          <span className="partner-deals-icon">⭐</span>
          <div>
            <CardHeader title="Partner Deals &amp; Developer Ecosystem" />
            <p className="partner-deals-subtitle">
              Externalized partner offers, sponsored developer credits, and tooling integrations.
            </p>
          </div>
        </div>
      }
    >
        {/* Notice explaining clean UI guarantee */}
        <Notice tone="success" variant="strip" density="compact" icon="🛡️" title="Clean Workspace Guarantee:">
          Ads and promotional banners have been externalized from all trading tabs. You can browse offers here on-demand without cluttering your workspace.
        </Notice>

        {/* Category Filters */}
        <PillGroup
          options={categories.map((cat) => ({ id: cat, label: cat }))}
          value={filterCategory}
          onChange={setFilterCategory}
          ariaLabel="Deal categories"
          className="partner-deals-category-bar"
        />

        {/* Deals Grid */}
        <div className="partner-deals-grid">
          {filteredDeals.map((deal) => {
            const color = deal.accentColor || "var(--color-accent)";
            return (
              <div key={deal.id} style={{ borderTop: `3px solid ${color}` }}>
              <Card>
                <div className="deal-card-header">
                  <span
                    className="deal-badge"
                    style={{ background: `${color}22`, color }}
                  >
                    {deal.badge || "PARTNER"}
                  </span>
                  <span className="deal-sponsor">{deal.sponsor}</span>
                </div>

                <CardHeader title={deal.title} />
                <p className="deal-tagline">{deal.tagline}</p>

                <div className="ui-footer-bar">
                  <Button
                    className="deal-cta-btn"
                    style={{ background: color }}
                    onClick={() => {
                      if (onAdClick) {
                        onAdClick(deal);
                      } else {
                        window.open(deal.url, "_blank", "noopener,noreferrer");
                      }
                    }}
                  >
                    {deal.ctaText || "Claim Deal →"}
                  </Button>
                  <a
                    href={deal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="deal-direct-link"
                    title={`Visit ${deal.sponsor}`}
                  >
                    Direct Link ↗
                  </a>
                </div>
              </Card>
              </div>
            );
          })}
        </div>

        {/* External Ad Network placements summary */}
        {externalAds && externalAds.length > 0 && (
          <div className="partner-deals-networks-strip">
            <span className="networks-label">🌐 Active Network Placements:</span>
            <div className="networks-list">
              {externalAds.map((ea, idx) => (
                <span
                  key={idx}
                  className="network-item-chip"
                  onClick={() => onExternalAdClick?.(ea)}
                  title={`Open ${ea.title}`}
                >
                  {ea.title} ({ea.network}) ➔
                </span>
              ))}
            </div>
          </div>
        )}

    </Modal>
  );
}
