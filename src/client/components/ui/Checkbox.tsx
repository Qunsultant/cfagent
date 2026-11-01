import React from "react";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /**
   * Optional label text or node, rendered as the wrapping <label>
   * (implicit association: clicking the text toggles the box). This
   * is the one way to label a Checkbox — callers must not wrap it in
   * their own raw <label> (issue #2177: 18 hand-rolled wrappers were
   * the reason the raw-label ceiling could not reach zero).
   */
  label?: React.ReactNode;
}

/**
 * Checkbox (#1577; E3) — native boolean toggle on tokens.
 * Bare control when no label is given (renders only the
 * <input type="checkbox"> with the token accent + a fixed box size).
 * With a label, renders the wrapping <label> on the token row
 * treatment (.ui-checkbox-label). There is no Switch/Toggle
 * primitive, and a checkbox through TextInput would inherit
 * text-field sizing (width: 100%) and render as a stretched box,
 * not a check square.
 * Styles: ./primitives.css.
 */
export function Checkbox({ className = "", label, ...rest }: CheckboxProps) {
  const input = <input type="checkbox" className={`ui-checkbox ${className}`} {...rest} />;
  if (label === undefined || label === null) return input;
  return (
    <label className="ui-checkbox-label">
      {input}
      {label}
    </label>
  );
}
