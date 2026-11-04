import React from "react";
import { createPortal } from "react-dom";
import { useAnchorPosition } from "./anchorPosition";

export interface MenuItem {
  id: string;
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface MenuProps {
  /** The element that opens the menu (usually a Button). */
  trigger: React.ReactElement;
  items: MenuItem[];
  ariaLabel: string;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Issue #3163: open on pointer hover in addition to click.
   * Hovering the trigger opens the panel; leaving the trigger starts
   * a short close delay that entering the panel cancels, so the
   * pointer can travel from trigger to panel (the panel is portaled,
   * so the trigger wrapper alone cannot cover the transit). Click
   * still toggles (the touch path): it pins the menu open, and a
   * second click unpins. Escape dismisses and suppresses hover
   * reopening until the pointer leaves and re-enters. Keyboard open
   * (Enter / Space / ArrowDown) is unchanged; hover adds no
   * focus-driven opening, so the portaled panel never traps focus
   * handling.
   */
  hoverOpen?: boolean;
}

/** Delay before a hover-opened menu closes after the pointer leaves
 * both trigger and panel — long enough to cross the trigger→panel
 * gap, short enough to feel immediate. */
const HOVER_CLOSE_DELAY_MS = 200;

/**
 * Menu (#2283 stream 5)
 * WAI-ARIA menu button: the trigger carries aria-haspopup/aria-expanded,
 * the panel is a portaled role="menu" with role="menuitem" buttons,
 * ArrowDown/Up/Home/End move between enabled items, Escape closes and
 * restores focus to the trigger, and an outside pointer press closes.
 * Disabled items are aria-disabled and never fire onSelect.
 * Styles: ./primitives.css (.ui-menu*), tokens only.
 */
export function Menu({
  trigger,
  items,
  ariaLabel,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  hoverOpen = false,
}: MenuProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  // Issue #3163 hover state. `hovered` = pointer over the trigger
  // wrapper; `panelHovered` = pointer over the portaled panel;
  // `dismissed` = Escape / click-to-close / item select suppressed a
  // hover opening until the pointer leaves and re-enters.
  const [hovered, setHovered] = React.useState(false);
  const [panelHovered, setPanelHovered] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHover = React.useRef(false);
  const hoverDrivenOpen = hoverOpen && (hovered || panelHovered) && !dismissed;
  const open = controlledOpen ?? (internalOpen || hoverDrivenOpen);
  const wrapRef = React.useRef<HTMLSpanElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const pos = useAnchorPosition(wrapRef, panelRef, open, align);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next);
      if (next) {
        setDismissed(false);
        openedByHover.current = false;
      } else if (hoverOpen && (hovered || panelHovered)) {
        // Closing while the pointer is still over the menu (Escape,
        // click-to-close, item select): suppress hover reopening
        // until the pointer leaves and re-enters.
        setDismissed(true);
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange, hoverOpen, hovered, panelHovered],
  );

  // Issue #3163: shared hover-leave timer. Leaving the trigger or
  // the panel starts it; entering either cancels it. On expiry the
  // pointer is over neither, so hover state clears (a pinned menu
  // stays open via internalOpen; a controlled caller that mirrored
  // a hover opening gets onOpenChange(false)).
  const clearCloseTimer = React.useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  React.useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const scheduleHoverClose = React.useCallback(() => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setHovered(false);
      setPanelHovered(false);
      if (controlledOpen !== undefined && openedByHover.current) {
        openedByHover.current = false;
        onOpenChange?.(false);
      }
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer, controlledOpen, onOpenChange]);

  const handleTriggerEnter = React.useCallback(() => {
    if (!hoverOpen) return;
    clearCloseTimer();
    setDismissed(false);
    if (!open) openedByHover.current = true;
    setHovered(true);
    if (controlledOpen !== undefined) onOpenChange?.(true);
  }, [hoverOpen, clearCloseTimer, open, controlledOpen, onOpenChange]);

  const handleTriggerLeave = React.useCallback(() => {
    if (!hoverOpen) return;
    scheduleHoverClose();
  }, [hoverOpen, scheduleHoverClose]);

  const handlePanelEnter = React.useCallback(() => {
    if (!hoverOpen) return;
    clearCloseTimer();
    setPanelHovered(true);
  }, [hoverOpen, clearCloseTimer]);

  const handlePanelLeave = React.useCallback(() => {
    if (!hoverOpen) return;
    scheduleHoverClose();
  }, [hoverOpen, scheduleHoverClose]);

  const enabledIndexes = React.useMemo(
    () => items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0),
    [items],
  );

  const focusTrigger = React.useCallback(() => {
    const wrap = wrapRef.current;
    const focusable = wrap?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? wrap)?.focus?.();
  }, []);

  const close = React.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    focusTrigger();
  }, [setOpen, focusTrigger]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (wrapRef.current?.contains(target)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close, setOpen]);

  React.useEffect(() => {
    if (open && activeIndex >= 0) {
      itemRefs.current[activeIndex]?.focus();
    }
  }, [open, activeIndex]);

  const move = (dir: 1 | -1) => {
    if (!enabledIndexes.length) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next =
      current === -1
        ? dir === 1
          ? enabledIndexes[0]
          : enabledIndexes[enabledIndexes.length - 1]
        : enabledIndexes[(current + dir + enabledIndexes.length) % enabledIndexes.length];
    setActiveIndex(next);
  };

  const triggerEl = React.cloneElement(trigger, {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onClick: (event: React.MouseEvent) => {
      (trigger.props as { onClick?: (e: React.MouseEvent) => void }).onClick?.(event);
      setOpen(!open);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      (trigger.props as { onKeyDown?: (e: React.KeyboardEvent) => void }).onKeyDown?.(event);
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        setOpen(true);
        setActiveIndex(enabledIndexes[0] ?? -1);
      }
    },
  } as Partial<unknown>);

  const panel = open ? (
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      className="ui-menu"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={handlePanelEnter}
      onMouseLeave={handlePanelLeave}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          setActiveIndex(enabledIndexes[0] ?? -1);
        } else if (event.key === "End") {
          event.preventDefault();
          setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? -1);
        }
      }}
    >
      <ul className="ui-menu-list">
        {items.map((item, i) => (
          <li key={item.id} role="presentation">
            <button
              ref={(node) => {
                itemRefs.current[i] = node;
              }}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled ? "true" : undefined}
              disabled={item.disabled}
              className={`ui-menu-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                close();
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <>
      <span
        ref={wrapRef}
        className="ui-menu-trigger"
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleTriggerLeave}
      >
        {triggerEl}
      </span>
      {typeof document !== "undefined" && panel ? createPortal(panel, document.body) : panel}
    </>
  );
}
