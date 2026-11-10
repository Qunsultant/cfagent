import React from "react";
import { Card } from "./Card";
import { Stack } from "./Stack";
import { CardHeader, type CardHeaderProps } from "./CardHeader";

export interface WorkCardProps extends CardHeaderProps {
  children: React.ReactNode;
}

/**
 * WorkCard (#3133, Part of #2150)
 * The input-flow card: the order form card (OrderTicketPanel.tsx:370)
 * rebuilt as a primitive — flat Card surface, CardHeader, then the
 * input flow, on the form card's 1.25rem column rhythm (Stack gap 5).
 * One deliberate delta from the original: the surface is the
 * formalized Card (pad-md 1.25rem, 12px radius — the form card's
 * var(--radius-lg) — card shadow) where the hand-rolled card used
 * bespoke 1.5rem padding and no shadow — the same class of delta as
 * #3132's organisms. Pages migrate onto it in Wave 1 (#3138–#3140);
 * this slice builds the organism only.
 */
export function WorkCard({ title, subtitle, meta, belowSubtitle, children }: WorkCardProps) {
  return (
    <Card>
      <Stack gap="5">
        <CardHeader title={title} subtitle={subtitle} meta={meta} belowSubtitle={belowSubtitle} />
        {children}
      </Stack>
    </Card>
  );
}
