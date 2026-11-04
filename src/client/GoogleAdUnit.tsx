import React, { useEffect, useRef } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Button } from "./components/ui";
import { isAdBeaconsPaused } from "./adBeacons";

export interface GoogleAdUnitProps {
  format?: "leaderboard" | "rectangle" | "responsive" | "mobile";
  slot?: string;
  publisherId?: string;
  ad?: {
    id?: string;
    title: string;
    tagline: string;
    ctaText?: string;
    targetUrl: string;
    network?: string;
    cpmRate?: number;
    cpcRate?: number;
  };
  onTrackClick?: (ad: any) => void;
  className?: string;
}

const DEFAULT_GOOGLE_CAMPAIGNS = [
  {
    id: "g_ad_vertex",
    title: "Google Cloud Vertex AI & TPU v5e",
    tagline: "Build, deploy, and scale enterprise multimodal AI models with sub-second latency.",
    ctaText: "Start Free with $300 Credits →",
    targetUrl: "https://cloud.google.com/vertex-ai",
    sponsorUrl: "cloud.google.com",
    badge: "Google Cloud AI",
  },
  {
    id: "g_ad_workspace",
    title: "Google Workspace with Gemini Enterprise",
    tagline: "Supercharge developer teams with AI-powered docs, sheets, code summaries, and Google Meet.",
    ctaText: "Try Gemini Free for 14 Days →",
    targetUrl: "https://workspace.google.com",
    sponsorUrl: "workspace.google.com",
    badge: "Google Workspace",
  },
  {
    id: "g_ad_bigquery",
    title: "Google BigQuery Serverless Analytics",
    tagline: "Query petabytes of analytics data in seconds without managing servers or storage infrastructure.",
    ctaText: "Explore BigQuery Studio →",
    targetUrl: "https://cloud.google.com/bigquery",
    sponsorUrl: "cloud.google.com/bigquery",
    badge: "Google Cloud Data",
  },
];

export function GoogleAdUnit({
  format = "responsive",
  slot = "7812903456",
  publisherId = "ca-pub-9842109842109842",
  ad,
  onTrackClick,
  className = "",
}: GoogleAdUnitProps) {
  const trackedRef = useRef(false);

  // Pick campaign: either passed ad or select from default Google campaigns
  const campaign = ad || DEFAULT_GOOGLE_CAMPAIGNS[0];
  const displayUrl = campaign.targetUrl
    ? new URL(campaign.targetUrl).hostname.replace(/^www\./, "")
    : "google.com/ads";

  // Automatically track impression once per mount — unless the user
  // paused ad beacons from the Workflow Runs toolbar (#2786 Part 2).
  // Pausing stops the tracking fetch only; the ad still renders.
  useEffect(() => {
    if (!trackedRef.current && ad?.id && !isAdBeaconsPaused()) {
      trackedRef.current = true;
      try {
        fetch("/api/external-ads/impression", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ad.id }),
        }).catch(() => {});
      } catch {
        // Ignore
      }
    }
  }, [ad?.id]);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onTrackClick) {
      onTrackClick(campaign);
    } else if (ad?.id && !isAdBeaconsPaused()) {
      try {
        fetch("/api/external-ads/click", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ad.id }),
        }).catch(() => {});
      } catch {
        // Ignore
      }
    }
    window.open(campaign.targetUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`google-ad-container format-${format} ${className}`}>
      {/* Official Google Ads Top Header Badge */}
      <div className="google-ad-header">
        <div className="google-ad-badge-group">
          <span className="google-ad-pill">Ad</span>
          <span className="google-ad-label">Google Ads</span>
        </div>
        <div className="google-ad-choices" title="Why this ad? Powered by Google Ads Network">
          <a
            href="https://adssettings.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="google-adchoices-link"
          >
            AdChoices <span className="adchoices-icon">ⓘ</span>
          </a>
        </div>
      </div>

      {/* Main Ad Body */}
      <div className="google-ad-body" onClick={handleClick}>
        <div className="google-ad-content">
          <div className="google-ad-url-row">
            <span className="google-ad-display-url">https://{displayUrl}</span>
            <span className="google-ad-verified-badge" title="Verified Google Advertiser">✓ Verified</span>
          </div>
          <h4 className="google-ad-title">{campaign.title}</h4>
          <p className="google-ad-description">{campaign.tagline}</p>
        </div>

        <div className="google-ad-action-area">
          <Button type="button" className="google-ad-cta-btn">
            {campaign.ctaText || "Learn More →"}
          </Button>
        </div>
      </div>

      {/* Footer Network Metadata */}
      <div className="google-ad-footer">
        <span className="google-ad-client-info">
          Google Publisher: <code>{publisherId.slice(0, 10)}...</code> | Slot: <code>{slot}</code>
        </span>
        <span className="google-ad-network-tag">🌐 Google Ad Network</span>
      </div>
    </div>
  );
}
