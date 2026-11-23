import React from "react";
import {
  Button,
  Card,
  CardHeader,
  Flex,
  Notice,
  PageSection,
  PageTemplate,
} from "./components/ui";
import { DEFAULT_LEFT_NAV_CONFIG } from "./navConfig";
import { isTabFeatureEnabled } from "./featureFlags";
import {
  NAV_PRESET_LABELS,
  leftNavConfigIds,
  type NavPresetKey,
} from "./navPresets";
import { NavPresetButtons } from "./components/NavigationMenu";
import { BrokerDynamicMenu, type SettingsMenuProps } from "./BrokerDynamicMenu";

export interface NavSettingsPageProps {
  /** The completed visible-tabs map (all config ids present). */
  visibleTabs: Record<string, boolean>;
  /** The preset the map exactly matches, or null for a custom mix. */
  activePreset: NavPresetKey | null;
  onToggleTabVisibility: (tabId: string) => void;
  onApplyPreset: (key: NavPresetKey) => void;
  /** Dynamic settings menu props (#3828): rendered inline on this page. */
  settingsMenuProps?: SettingsMenuProps;
}

/**
 * Navigation Settings (issues 3696 S1 + 3697 S2, subs of epic 3695).
 *
 * Nav presets + visible tabs ONLY — per-product settings live in the
 * header Settings menu, not here. Presets are computed from the
 * left-nav config, so the pills below iterate the config (26 items):
 * every toggleable tab gets a pill, including the menu-only and
 * hand-inserted ones (goal-screen, orders, schedules, sandbox) the old
 * menu pills never covered. Route-only ids (checkout, docs, endpoints,
 * ledger, payment-assurance, revenue, workflows) have no pill of their
 * own — they follow their left-nav parent.
 *
 * Primitives only, no bespoke classes: Button variant + aria-pressed
 * carry pill state, CardHeader carries the card headings.
 */
export function NavSettingsPage({
  visibleTabs,
  activePreset,
  onToggleTabVisibility,
  onApplyPreset,
  settingsMenuProps,
}: NavSettingsPageProps) {
  const total = leftNavConfigIds().length;
  const visibleCount = leftNavConfigIds().filter(
    (id) => visibleTabs[id] === true,
  ).length;
  return (
    <PageTemplate
      title="Settings"
      scopeNote="Manage broker, environment, display, ticker, and navigation visibility settings."
    >
      {settingsMenuProps && (
        <PageSection
          title="Platform & Broker Settings"
          description="Broker connection, trading mode, theme, layout, auto-refresh, and ticker tape controls."
        >
          <BrokerDynamicMenu {...settingsMenuProps} variant="page" />
        </PageSection>
      )}
      <PageSection
        title="Presets"
        description="A preset sets every tab at once. Any manual change after that makes the selection custom until a preset matches it again."
      >
        <Card>
          <CardHeader
            title="Navigation presets"
            subtitle={
              activePreset
                ? `Active preset: ${NAV_PRESET_LABELS[activePreset]} — ${visibleCount} of ${total} tabs visible.`
                : `Custom selection — ${visibleCount} of ${total} tabs visible. No preset matches the current tabs.`
            }
          />
          <NavPresetButtons
            activePreset={activePreset}
            onApplyPreset={onApplyPreset}
          />
          {activePreset === "none" && (
            <Notice tone="info" title="Nothing is selected">
              Every navigation tab is hidden in both the left and top
              navigation. Pick any other preset to show tabs again.
            </Notice>
          )}
        </Card>
      </PageSection>
      <PageSection
        title="Visible tabs"
        description="Toggle tabs one by one. A hidden tab hides its sub-items too; route-only tabs follow their parent tab."
      >
        {DEFAULT_LEFT_NAV_CONFIG.sections.map((section) => {
          const pills = section.items.filter((item) =>
            isTabFeatureEnabled(item.id),
          );
          if (pills.length === 0) return null;
          const sectionVisible = pills.filter(
            (item) => visibleTabs[item.id] === true,
          ).length;
          return (
            <Card key={section.id}>
              <CardHeader
                title={section.title}
                subtitle={`${sectionVisible} of ${pills.length} visible`}
              />
              <Flex gap="2" wrap>
                {pills.map((item) => {
                  const isVisible = visibleTabs[item.id] === true;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant={isVisible ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => onToggleTabVisibility(item.id)}
                      aria-pressed={isVisible}
                      data-tab-id={item.id}
                      title={`${item.label} (${section.title}): ${isVisible ? "Visible in navigation (click to hide)" : "Hidden from navigation (click to show)"}`}
                    >
                      {isVisible ? "✓ " : "○ "}
                      {item.label}
                    </Button>
                  );
                })}
              </Flex>
            </Card>
          );
        })}
      </PageSection>
    </PageTemplate>
  );
}
