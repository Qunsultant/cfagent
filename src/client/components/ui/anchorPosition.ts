import React from "react";

export interface AnchorPosition {
  top: number;
  left: number;
}

/**
 * Shared anchor positioning for Menu and Popover (#2283 stream 5).
 * The panel renders fixed under its anchor and clamps to the viewport:
 * it flips above the anchor when it would overflow the bottom edge and
 * slides in from the right edge when it would overflow horizontally.
 * Positions are measured, never literal offsets, so no token is violated.
 */
export function useAnchorPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  align: "start" | "end",
): AnchorPosition {
  const [pos, setPos] = React.useState<AnchorPosition>({ top: 0, left: 0 });

  React.useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const gap = 4;
    let top = rect.bottom + gap;
    if (top + panelRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - panelRect.height - gap);
    }
    let left = align === "end" ? rect.right - panelRect.width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - panelRect.width - 8));
    setPos({ top, left });
  }, [open, align, anchorRef, panelRef]);

  return pos;
}
