import React from "react";
import { Card } from "./Card";
import { Stack } from "./Stack";
import { CardHeader, type CardHeaderProps } from "./CardHeader";

export interface DetailCardProps extends CardHeaderProps {
  children: React.ReactNode;
}

/**
 * DetailCard (#3133, Part of #2150)
 * The content-block card: the autopilot chart card
 * (AutopilotControlCenter.tsx:818) rebuilt as a primitive — elevated
 * Card surface (the chart card's raised e2 shadow, formalized),
 * CardHeader, then the content, on the chart card's 1rem header
 * rhythm (Stack gap 4). The chart card's title lives in the
 * PageSection above it, so the header is meta-only here — timeframe
 * pills pushed right. One deliberate delta from the original: the
 * surface is the formalized elevated Card (pad-md 1.25rem) where the
 * hand-rolled card used bespoke 1.25rem/1.35rem padding. Pages
 * migrate onto it in Wave 1 (#3138–#3140); this slice builds the
 * organism only.
 */
export function DetailCard({ title, subtitle, meta, belowSubtitle, children }: DetailCardProps) {
  return (
    <Card elevated>
      <Stack gap="4">
        <CardHeader title={title} subtitle={subtitle} meta={meta} belowSubtitle={belowSubtitle} />
        {children}
      </Stack>
    </Card>
  );
}
