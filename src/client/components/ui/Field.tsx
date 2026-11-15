import React from "react";

export interface FieldShellProps {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * FieldShell (#492) — shared label/hint/error chrome for the form
 * primitives (TextInput, Select). Wires the label via htmlFor and the
 * hint/error via ids the control references with aria-describedby
 * (docs/architecture/UX/ux-architecture.md section 13: accessible errors).
 * Internal helper for components/ui; not a standalone primitive.
 */
export function FieldShell({ id, label, hint, error, className = "", children }: FieldShellProps) {
  return (
    <div className={`ui-field ${className}`}>
      {label && (
        <label className="ui-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className="ui-field-msg error" id={`${id}-msg`}>
          {error}
        </span>
      ) : hint ? (
        <span className="ui-field-msg" id={`${id}-msg`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Builds the aria-describedby value for a field control. */
export function fieldDescribedBy(id: string, hint?: string, error?: string): string | undefined {
  return hint || error ? `${id}-msg` : undefined;
}
