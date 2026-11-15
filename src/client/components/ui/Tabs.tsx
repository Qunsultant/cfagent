import React from "react";
import { getSegmentNavigationTarget, getSegmentTabStop } from "./segmentedNavigation";

export interface TabOption<T extends string = string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  tabs: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** Id prefix linking tabs to their panels: `<idBase>-tab-<id>` / `<idBase>-panel-<id>`. */
  idBase: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Tabs (#492)
 * WAI-ARIA tablist (docs/architecture/UX/ux-architecture.md section 13): roving
 * tabindex, arrow/Home/End keyboard navigation with automatic
 * activation, aria-selected + aria-controls wired to TabPanel.
 * SegmentedControl is the sibling for non-navigation selection.
 * Styles: ./primitives.css.
 */
export function Tabs<T extends string = string>({
  tabs,
  value,
  onChange,
  ariaLabel = "Tabs",
  idBase,
  size = "md",
  className = "",
}: TabsProps<T>) {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const tabStop = getSegmentTabStop(tabs, value);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = getSegmentNavigationTarget(tabs, index, event.key);
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    if (tabs[target].id !== value) onChange(tabs[target].id);
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={`ui-tabs size-${size} ${className}`}>
      {tabs.map((tab, index) => {
        const isSelected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.id}`}
            aria-selected={isSelected}
            aria-controls={`${idBase}-panel-${tab.id}`}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={tab.disabled}
            className={`ui-tab ${isSelected ? "selected" : ""}`}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => !tab.disabled && onChange(tab.id)}
          >
            {tab.icon && (
              <span className="ui-tab-icon" aria-hidden="true">
                {tab.icon}
              </span>
            )}
            <span className="ui-tab-label">{tab.label}</span>
            {tab.badge !== undefined && <span className="ui-tab-badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** Must match the Tabs idBase. */
  idBase: string;
  tabId: string;
  active: boolean;
  /**
   * Retain mode (#1804 S2, issue #2027): an inactive retained panel stays
   * mounted-hidden (the #1379 pattern) so in-flight and finished work
   * survives tab switches. Default off — inactive panels render nothing,
   * preserving the mount/unmount behavior surfaces already use.
   */
  retain?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * TabPanel — the panel half of the Tabs pattern. Renders nothing while
 * inactive (preserving the mount/unmount behavior surfaces already use),
 * unless `retain` keeps it mounted-hidden.
 */
export function TabPanel({ idBase, tabId, active, retain = false, className = "", children }: TabPanelProps) {
  if (!active && !retain) return null;
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${tabId}`}
      aria-labelledby={`${idBase}-tab-${tabId}`}
      tabIndex={0}
      className={className}
      hidden={!active}
      style={!active ? { display: "none" } : undefined}
    >
      {children}
    </div>
  );
}
