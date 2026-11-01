import React from "react";
import { createPortal } from "react-dom";
import { useAnchorPosition } from "./anchorPosition";

export interface PopoverProps {
  /** The element that toggles the popover (usually a Button). */
  trigger: React.ReactElement;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Popover (#2283 stream 5)
 * Non-modal floating panel anchored to a trigger: click toggles, Escape
 * closes, an outside pointer press closes. Portaled to body and positioned
 * by the shared anchor hook (same placement as Menu). No focus trap by
 * design — focus stays on the trigger; the panel is a named dialog.
 * Styles: ./primitives.css (.ui-popover*), tokens only.
 */
export function Popover({
  trigger,
  title,
  ariaLabel,
  children,
  align = "start",
  open: controlledOpen,
  onOpenChange,
}: PopoverProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const wrapRef = React.useRef<HTMLSpanElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const pos = useAnchorPosition(wrapRef, panelRef, open, align);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (wrapRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, setOpen]);

  const triggerEl = React.cloneElement(trigger, {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    onClick: (event: React.MouseEvent) => {
      (trigger.props as { onClick?: (e: React.MouseEvent) => void }).onClick?.(event);
      setOpen(!open);
    },
  } as Partial<unknown>);

  const panel = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title ?? ariaLabel}
      className="ui-popover"
      style={{ top: pos.top, left: pos.left }}
    >
      {title && <div className="ui-popover-title">{title}</div>}
      <div className="ui-popover-body">{children}</div>
    </div>
  ) : null;

  return (
    <>
      <span ref={wrapRef} className="ui-popover-trigger">
        {triggerEl}
      </span>
      {typeof document !== "undefined" && panel ? createPortal(panel, document.body) : panel}
    </>
  );
}
