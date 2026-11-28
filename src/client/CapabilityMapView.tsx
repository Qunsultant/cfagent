/**
 * SupraHub Capability Map (issue #6709).
 *
 * The home for the Supra capability names: company, platform, pipeline,
 * and the thirteen capabilities with their supports-today statuses and
 * app surfaces. Every name, definition, and status comes from the brand
 * manifest through the BrandPort (`src/config/brand.ts`) — this component
 * contains no hardcoded Supra literals, so a rename in the manifest
 * renders here with no code change (see the rename-drill test).
 *
 * Deep-links: `?tab=workflows&view=capabilities` opens this view;
 * `&capability=<key>` scrolls to and highlights one capability row.
 * Surface links navigate through `onNavigateTab` (tab + optional view),
 * the same seam the Capability & Lookup Matrix view uses.
 */

import { useEffect, useMemo, useState } from "react";
import {
  getBrandPort,
  type BrandCapability,
  type BrandCapabilityStatus,
} from "../config/brand";
import { navigateToTab, subscribeToRouteChanges } from "./router";
import {
  Badge,
  Button,
  Card,
  Flex,
  Notice,
  Stack,
  Table,
  TextInput,
} from "./components/ui";

const STATUS_LABEL: Record<BrandCapabilityStatus, string> = {
  available: "Available",
  partial: "Partial",
  "not-available": "Not available",
};

const STATUS_TONE: Record<BrandCapabilityStatus, "success" | "warning" | "danger"> = {
  available: "success",
  partial: "warning",
  "not-available": "danger",
};

function readCapabilityParam(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("capability");
  return value && value.trim().length > 0 ? value.trim() : null;
}

export interface CapabilityMapViewProps {
  /** Navigate to an app surface (tab + optional `?view=` value). */
  onNavigateTab: (tab: string, view?: string) => void;
}

export function CapabilityMapView({ onNavigateTab }: CapabilityMapViewProps) {
  const brand = getBrandPort().getBrand();
  const capabilities = brand.capabilities;
  const [query, setQuery] = useState("");
  const [linkedKey, setLinkedKey] = useState<string | null>(() => readCapabilityParam());

  useEffect(() => {
    const sync = () => {
      const key = readCapabilityParam();
      setLinkedKey(key);
      if (key) {
        const row = document.getElementById(`capability-${key}`);
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "nearest" });
        }
      }
    };
    sync();
    return subscribeToRouteChanges(sync);
  }, []);

  const counts = useMemo(() => {
    const next: Record<BrandCapabilityStatus, number> = {
      available: 0,
      partial: 0,
      "not-available": 0,
    };
    for (const capability of capabilities) next[capability.status] += 1;
    return next;
  }, [capabilities]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (normalizedQuery.length === 0) return capabilities;
    return capabilities.filter((capability) => {
      const haystack = [
        capability.displayName,
        capability.shortName,
        capability.tagline,
        capability.description,
        capability.group,
        STATUS_LABEL[capability.status],
        ...capability.surfaces.map((surface) => surface.label),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [capabilities, normalizedQuery]);

  const pipelineNames = brand.pipeline
    .map((key) => capabilities.find((capability) => capability.key === key)?.displayName ?? key)
    .join(" → ");

  const deepLinkTo = (capability: BrandCapability) => {
    navigateToTab("workflows", "capabilities", { capability: capability.key });
  };

  return (
    <Stack gap="3">
      <Card>
        <Stack gap="2">
          <Flex gap="2" align="center" wrap>
            <strong>
              {brand.company.name} <span style={{ color: "var(--color-text-muted)" }}>· company</span>
            </strong>
            <span style={{ color: "var(--color-text-muted)" }}>owns the platform</span>
            <strong>
              {brand.platform.name} <span style={{ color: "var(--color-text-muted)" }}>· platform</span>
            </strong>
          </Flex>
          <p style={{ margin: 0 }}>{brand.platform.description}</p>
          <p style={{ margin: 0 }}>
            <strong>Pipeline:</strong> {pipelineNames}
          </p>
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{brand.pipelineNote}</p>
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{brand.pipelineCaption}</p>
        </Stack>
      </Card>

      <TextInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter capabilities by name, group, status, or surface…"
        aria-label="Filter capabilities"
      />

      <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
        {capabilities.length} capabilities · {counts.available} Available · {counts.partial} Partial ·{" "}
        {counts["not-available"]} Not available
      </p>

      <Table<BrandCapability>
        caption={`${brand.platform.name} capabilities`}
        stickyHeader
        rows={filtered}
        rowKey={(capability) => capability.key}
        rowClassName={(capability) => (capability.key === linkedKey ? "is-selected" : "")}
        rowProps={(capability) => ({ id: `capability-${capability.key}` })}
        empty={
          <Notice tone="info" title="No capabilities match">
            No capabilities match &ldquo;{query.trim()}&rdquo;. Clear the filter to see all{" "}
            {capabilities.length} capabilities.
          </Notice>
        }
        columns={[
          {
            key: "capability",
            header: "Capability",
            render: (capability) => (
              <Stack gap="1">
                <Flex gap="2" align="center">
                  <strong>{capability.displayName}</strong>
                  <Button
                    variant="secondary"
                    tone="subtle"
                    size="sm"
                    onClick={() => deepLinkTo(capability)}
                    title="Deep-link to this capability"
                  >
                    Link
                  </Button>
                </Flex>
                <span style={{ color: "var(--color-text-muted)" }}>{capability.group}</span>
              </Stack>
            ),
          },
          {
            key: "definition",
            header: "Definition",
            render: (capability) => (
              <Stack gap="1">
                <span>{capability.tagline}</span>
                <span style={{ color: "var(--color-text-muted)" }}>{capability.description}</span>
              </Stack>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (capability) => (
              <Badge tone={STATUS_TONE[capability.status]}>{STATUS_LABEL[capability.status]}</Badge>
            ),
          },
          {
            key: "surface",
            header: "App surface",
            render: (capability) =>
              capability.surfaces.length === 0 ? (
                <span style={{ color: "var(--color-text-muted)" }}>No direct user surface — map only</span>
              ) : (
                <Stack gap="1">
                  {capability.surfaces.map((surface) => (
                    <Button
                      key={`${surface.tab}:${surface.view ?? ""}`}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                      onClick={() => onNavigateTab(surface.tab, surface.view)}
                    >
                      {surface.label} →
                    </Button>
                  ))}
                </Stack>
              ),
          },
        ]}
      />

      <Notice tone="info" title="Product catalog names stay out of brand">
        Product catalog names are operator-set product identities, not brand names — the manifest
        does not govern them.
      </Notice>
    </Stack>
  );
}
