import React from "react";

/**
 * SkipLink (#2673 slice 6) — the keyboard entry to main content.
 * Visually hidden until focused (see .ui-skip-link in primitives.css),
 * then a fixed, token-styled link. It must be the first focusable
 * element in the app root, and its target (#main-content) must carry
 * tabIndex={-1} so focus actually moves there.
 */
export function SkipLink() {
  return (
    <a className="ui-skip-link" href="#main-content">
      Skip to main content
    </a>
  );
}
