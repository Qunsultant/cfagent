import { BRAND } from "../branding";
import React from "react";
import { Button } from "./ui";
import { TabHoverItem } from "../TabHoverItem";

export interface CapabilityTabTooltip {
  eyebrow?: string;
  title: string;
  description: string;
}

export interface CapabilityTabItem {
  id: string;
  label: string;
  icon?: string | React.ReactNode;
  badge?: string | number;
  badgeType?: "default" | "cyan" | "emerald" | "amber" | "purple" | "live";
  tooltip?: CapabilityTabTooltip;
  disabled?: boolean;
}

export interface CapabilityNavBarProps {
  tabs: CapabilityTabItem[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  ariaLabel?: string;
  rightContent?: React.ReactNode;
  className?: string;
}

/**
 * CapabilityNavBar
 * Universal, accessible, high-density capability navigation bar for web-enabled financial & analytical systems.
 * Provides unified horizontal capability tabs with:
 * - WCAG 2.2 / ISO 9241-110 compliant keyboard navigation (role="tablist", role="tab", aria-selected)
 * - WYSIWYG self-descriptiveness via accessible hover tooltips (TabHoverItem)
 * - Luminous active indicators with theme-aware styling (light & dark mode)
 * - Integrated right-aligned contextual telemetry & actions area (Live status, refresh, dials)
 */
export function CapabilityNavBar({
  tabs,
  activeTabId,
  onTabChange,
  ariaLabel = "Page capabilities",
  rightContent,
  className = "",
}: CapabilityNavBarProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const enabledTabs = tabs.filter((t) => !t.disabled);
    const currentIndex = enabledTabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex === -1 && enabledTabs.length > 0) {
      onTabChange(enabledTabs[0].id);
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = (currentIndex + 1) % enabledTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
    } else if (event.key === "Home") {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      nextIndex = enabledTabs.length - 1;
    } else {
      return;
    }

    const nextTab = enabledTabs[nextIndex];
    if (nextTab && nextTab.id !== activeTabId) {
      onTabChange(nextTab.id);
      const nextBtn = document.getElementById(`cap-tab-${nextTab.id}`);
      nextBtn?.focus();
    }
  };

  return (
    <header className={`capability-nav-bar ${className}`}>
      <nav
        className="capability-tabs-strip"
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          const tabButton = (
            <Button
              variant="secondary"
              id={`cap-tab-${tab.id}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`screener-tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              disabled={tab.disabled}
              className={`capability-tab-btn ${isActive ? "active" : ""} ${tab.disabled ? "disabled" : ""}`}
              onClick={() => {
                if (!tab.disabled) {
                  onTabChange(tab.id);
                }
              }}
            >
              {tab.icon && <span className="capability-tab-icon">{tab.icon}</span>}
              <span className="capability-tab-label">{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== "" && (
                <span className={`capability-tab-badge badge-${tab.badgeType || "default"}`}>
                  {tab.badge}
                </span>
              )}
            </Button>
          );

          if (tab.tooltip) {
            return (
              <TabHoverItem
                key={tab.id}
                eyebrow={tab.tooltip.eyebrow}
                title={tab.tooltip.title}
                description={tab.tooltip.description}
              >
                {tabButton}
              </TabHoverItem>
            );
          }

          return (
            <div key={tab.id} className="capability-tab-wrapper">
              {tabButton}
            </div>
          );
        })}
      </nav>

      {rightContent && <div className="capability-nav-right">{rightContent}</div>}
    </header>
  );
}

export function CopilotTriggerButton({
  label = "✨ Ask Copilot",
  prompt,
  className = "",
}: {
  label?: string;
  prompt?: string;
  className?: string;
}) {
  return (
    <Button
      variant="secondary"
      className={`btn-capability-copilot ${className}`}
      onClick={() => {
        window.dispatchEvent(new CustomEvent("open-ask-agent", { detail: { prompt } }));
      }}
      title={`Open ${BRAND.copilotName} with contextual prompts`}
    >
      <span style={{ fontSize: "var(--font-size-body)" }}>🤖</span>
      <span>{label}</span>
    </Button>
  );
}
