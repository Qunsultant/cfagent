import React from "react";
import { FieldShell, fieldDescribedBy } from "./Field";

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  hint?: string;
  /** Error message; sets aria-invalid and the danger styling. */
  error?: string;
  size?: "sm" | "md";
  wrapperClassName?: string;
  /** Render a <textarea> instead of an <input> (for message/body fields). */
  multiline?: boolean;
  /** Textarea rows (multiline only). */
  rows?: number;
  /**
   * A control rendered INSIDE the field, at its trailing edge (#5843).
   * The shell owns the border and focus ring, so a mic/clear button sits
   * in the box rather than beside it.
   */
  trailing?: React.ReactNode;
  /** Forwarded to the rendered control (focus management, etc.). */
  ref?: React.Ref<HTMLInputElement | HTMLTextAreaElement>;
}

/**
 * TextInput (#492; ref forwarding + multiline added in #594)
 * Labeled text field on the token input family (--color-input*). With no
 * label/hint/error it renders the bare control (toolbars, filters).
 * Styles: ./primitives.css.
 */
export function TextInput({
  label,
  hint,
  error,
  size = "md",
  wrapperClassName = "",
  multiline = false,
  rows,
  trailing,
  ref,
  id,
  className = "",
  ...rest
}: TextInputProps) {
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fieldId = id ?? `ui-input-${autoId}`;
  const controlClassName = `ui-input size-${size} ${error ? "invalid" : ""} ${className}`;
  const bare = trailing !== undefined;
  const inputClassName = bare ? `ui-input-bare ${className}` : controlClassName;
  const describedBy = fieldDescribedBy(fieldId, hint, error);
  const control = multiline ? (
    <textarea
      id={fieldId}
      ref={ref as React.Ref<HTMLTextAreaElement>}
      rows={rows}
      className={controlClassName}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
    />
  ) : (
    <input
      id={fieldId}
      ref={ref as React.Ref<HTMLInputElement>}
      className={inputClassName}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );
  const boxed = trailing !== undefined ? (
    <span className={`ui-input-shell size-${size} ${error ? "invalid" : ""} ${wrapperClassName}`}>
      {control}
      {trailing}
    </span>
  ) : (
    control
  );
  if (!label && !hint && !error) return boxed;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} className={wrapperClassName}>
      {boxed}
    </FieldShell>
  );
}
