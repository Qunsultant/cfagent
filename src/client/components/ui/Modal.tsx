import React from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** String titles render as an <h2>; nodes render as-is. Either way the
   *  title element is the dialog's aria-labelledby target. */
  title?: React.ReactNode;
  ariaLabel?: string;
  /** Panel max-width scale. "none" = the panel class (panelClassName) owns sizing. */
  size?: "sm" | "md" | "lg" | "xl" | "none";
  /** Extra class on the dialog panel (e.g. a legacy modal-card class). */
  panelClassName?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal (#492)
 * Dialog built on the repo's Universal Modal System classes in
 * tokens.css (.modal-backdrop + .modal-dialog + .modal-header +
 * .btn-close-modal) with the behavior the spec requires
 * (docs/architecture/UX/ux-architecture.md section 13): portal to body, Escape
 * to close, backdrop-click to close, initial focus inside the dialog,
 * Tab kept inside (focus trap), focus restored to the opener on close,
 * and body scroll locked while open. Styles: ./primitives.css.
 */
export function Modal({
  open,
  onClose,
  title,
  ariaLabel,
  size = "md",
  panelClassName = "",
  footer,
  children,
}: ModalProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `ui-modal-title-${autoId}`;

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
      className="modal-backdrop"
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
        className={`modal-dialog ui-modal ${size !== "none" ? `size-${size}` : ""} ${panelClassName}`}
      >
        {title && (
          <div className="modal-header">
            {typeof title === "string" ? (
              <h2 id={titleId} className="ui-modal-title">
                {title}
              </h2>
            ) : (
              <div id={titleId} className="ui-modal-title">
                {title}
              </div>
            )}
            <button
              type="button"
              className="btn-close-modal ui-modal-close"
              aria-label="Close dialog"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        )}
        <div className="ui-modal-body">{children}</div>
        {footer}
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
