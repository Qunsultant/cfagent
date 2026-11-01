import React from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** String titles render as an <h2>; nodes render as-is. Either way the
   *  title element is the dialog's aria-labelledby target. */
  title?: React.ReactNode;
  ariaLabel?: string;
  /** Extra header controls rendered before the built-in close button
   *  (e.g. an expand action). */
  actions?: React.ReactNode;
  side?: "left" | "right";
  children: React.ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Drawer (#2283 stream 5)
 * Side panel on the Modal behavior contract (docs/agents/ux-architecture.md
 * section 13): portal to body, Escape/backdrop close, initial focus inside,
 * Tab kept inside (focus trap), focus restored to the opener on close, and
 * body scroll locked while open. Token z-order: backdrop below the modal
 * backdrop, panel above it, both below Toast — transient feedback always
 * stays on top. The AskAgentWidget drawer migrates here; its z-99995 rule
 * retires with the migration.
 * Styles: ./primitives.css (.ui-drawer*), tokens only.
 */
export function Drawer({
  open,
  onClose,
  title,
  ariaLabel,
  actions,
  side = "right",
  children,
}: DrawerProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `ui-drawer-title-${autoId}`;

  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => el.offsetParent !== null,
      );
    (focusables()[0] ?? panel)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open ]);

  if (!open) return null;

  const dialog = (
    <div
      className="ui-drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={`ui-drawer-panel side-${side}`}
      >
        <div className="ui-drawer-header">
          {title ? (
            typeof title === "string" ? (
              <h2 id={titleId} className="ui-drawer-title">
                {title}
              </h2>
            ) : (
              <div id={titleId} className="ui-drawer-title">
                {title}
              </div>
            )
          ) : (
            <span />
          )}
          {actions && <span className="ui-drawer-actions">{actions}</span>}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="ui-drawer-body">{children}</div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
