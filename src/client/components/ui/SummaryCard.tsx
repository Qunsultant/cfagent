import React from "react";
import { Flex } from "./Flex";
import { Stack } from "./Stack";

export type SummaryValueTone = "success" | "warning" | "danger";

export interface SummaryCardRow {
  label: string;
  value: string;
  valueTone?: SummaryValueTone;
}

export interface SummaryCardProps {
  rows: SummaryCardRow[];
  total?: { label: string; value: string };
}

/**
 * SummaryCard (#3132, Part of #2150)
 * The summary-card organism: the order calc card
 * (OrderTicketPanel.tsx:783) rebuilt as a primitive — label/value
 * rows with an emphasized total row. Same sunken surface, same muted
 * rows, same total treatment (border-top, primary text, success
 * mono value). Renders nothing with no rows and no total (§1.6b).
 * This is the label/value-rows + total shape, not CardHeader — the
 * risk profile card's header belongs to #3133. Pages migrate onto it
 * in Wave 1 (#3138–#3140); this slice builds the organism only.
 */
export function SummaryCard({ rows, total }: SummaryCardProps) {
  if (rows.length === 0 && !total) return null;
  return (
    <div className="ui-summary-card">
      <Stack gap="2">
        {rows.map((row, index) => (
          <Flex key={index} justify="between" align="center">
            <span>{row.label}</span>
            <span className={row.valueTone ? `ui-${row.valueTone}` : undefined}>
              {row.value}
            </span>
          </Flex>
        ))}
        {total && (
          <div className="ui-summary-total">
            <Flex justify="between" align="center">
              <span>{total.label}</span>
              <strong>{total.value}</strong>
            </Flex>
          </div>
        )}
      </Stack>
    </div>
  );
}
