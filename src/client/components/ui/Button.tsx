import React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "trade" | "accent" | "warning";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** solid = filled; subtle = tinted background + tone text/border (dense chips, table actions). */
  tone?: "solid" | "subtle";
  size?: "sm" | "md" | "lg";
  /** Shows a spinner and sets aria-busy; the button is disabled while loading. */
  loading?: boolean;
  /**
   * Renders an anchor instead of a button, with identical styling (#2776):
   * deep links need real hrefs (copyable, open-in-new-tab) while keeping
   * the primitive's look. Pair with an onClick that preventDefaults and
   * navigates SPA-style; the href is what makes the link addressable.
   */
  href?: string;
  target?: React.HTMLAttributeAnchorTarget;
  /**
   * Anchor-only: passed through to the rendered <a> when `href` is set
   * (the anchor branch spreads ...rest onto it). Without `href` it has
   * no effect — ButtonProps extends button attributes, so this has to
   * be declared here or `download` fails typecheck at the call site.
   */
  download?: string | boolean;
}

/**
 * Button (#492)
 * The shared action button. Variants map to semantic token pairs only
 * (./primitives.css), so it follows every theme by construction.
 * Defaults to type="button" — pass type="submit" inside forms.
 */
export function Button({
  variant = "secondary",
  tone = "solid",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className = "",
  children,
  href,
  target,
  ...rest
}: ButtonProps) {
  const classes = `ui-btn variant-${variant} tone-${tone} size-${size} ${className}`;
  if (href !== undefined) {
    // Anchor branch: the button-typed ...rest is cast, not re-typed —
    // callers pass element-generic handlers (React.MouseEvent), and no
    // href caller relies on button-element-only handler signatures.
    const anchorProps = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        className={classes}
        href={href}
        target={target}
        rel={target === "_blank" ? "noopener" : undefined}
        aria-busy={loading || undefined}
        aria-disabled={disabled || undefined}
        {...anchorProps}
      >
        {loading && <span className="ui-btn-spinner" aria-hidden="true" />}
        {children}
      </a>
    );
  }
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="ui-btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
