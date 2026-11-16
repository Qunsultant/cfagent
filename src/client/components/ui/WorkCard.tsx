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
 *
 * @deprecated #4913 (sub of #3695): the single use (OrderTicketPanel)
 * is folded into the inline Card + Stack gap 5 + CardHeader composition
 * WorkCard itself renders — the component is only that composition, so
 * a second use would be a duplicate, not a reuse. New cards use
 * `<Card><Stack gap="5"><CardHeader … />…</Stack></Card>` directly.
 * The component stays exported (no file deletion, gitops §22) and
 * exercised in tests/composable_ui_primitives.test.ts; the census test
 * (tests/template_rule_of_three_4913.test.ts) pins zero prod uses.
 */
export function WorkCard({ title, subtitle, meta, belowSubtitle, singleLine, children }: WorkCardProps) {
  return (
    <Card>
      <Stack gap="5">
        <CardHeader
          title={title}
          subtitle={subtitle}
          meta={meta}
          belowSubtitle={belowSubtitle}
          singleLine={singleLine}
        />
        {children}
      </Stack>
    </Card>
  );
}
