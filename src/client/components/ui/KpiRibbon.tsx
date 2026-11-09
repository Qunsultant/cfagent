import React from "react";
import { Card } from "./Card";
import { Stack } from "./Stack";

export type KpiSubTone = "success" | "warning" | "danger";

export interface KpiRibbonItem {
  label: string;
  value: string;
  sub?: string;
  subTone?: KpiSubTone;
}

export interface KpiRibbonProps {
  items: KpiRibbonItem[];
}

/**
 * KpiRibbon (#3132, Part of #2150)
 * The KPI-ribbon slot (design-system §1.6b slot 3): the autopilot
 * executive ribbon (AutopilotControlCenter.tsx:775) rebuilt as a
 * primitive. One Card per item — label, value, sub-trend — on the
 * shared .ui-stat-grid, which wraps 4 → 2 → 1 the same way the
 * ribbon's fixed grid did. Renders nothing with no items (§1.6b).
 * Pages migrate onto it in Wave 1 (#3138–#3140); this slice builds
 * the organism only.
 */
export function KpiRibbon({ items }: KpiRibbonProps) {
  if (items.length === 0) return null;
  return (
    <div className="ui-stat-grid">
      {items.map((item, index) => (
        <Card key={index}>
          <Stack gap="1">
            <span className="ui-meta-sm">{item.label}</span>
            <div>
              <strong>{item.value}</strong>
            </div>
            {item.sub && (
              <span
                className={
                  item.subTone ? `ui-meta-sm ui-${item.subTone}` : "ui-meta-sm"
                }
              >
                {item.sub}
              </span>
            )}
          </Stack>
        </Card>
      ))}
    </div>
  );
}
