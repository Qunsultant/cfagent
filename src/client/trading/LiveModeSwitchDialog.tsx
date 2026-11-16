import React from "react";
import { ConfirmModal } from "../scheduledOptionsManager/ConfirmModal";
import { liveModeConfirmCopy } from "./liveMode";

export interface LiveModeSwitchDialogProps {
  open: boolean;
  /** The selected broker's name, as the surface resolved it. */
  brokerLabel: string;
  /** The broker id, so the copy can state "no paper mode" only where it is true. */
  broker: unknown;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Issue #4649 (matrix gap 1) — the confirmation for arming live trading.
 *
 * One dialog for every TEST→PROD switch, built on the sanctioned
 * `ConfirmModal` primitive (`on Modal`, `tone="danger"`) so Escape, focus
 * trap/restore, backdrop close and scroll lock behave exactly like the other
 * destructive confirmations. The copy lives in `liveMode.ts` so it is pinned by
 * a test and reused by #4652's general mode switch — never duplicated per
 * surface.
 */
export function LiveModeSwitchDialog({
  open,
  brokerLabel,
  broker,
  onConfirm,
  onClose,
}: LiveModeSwitchDialogProps) {
  const copy = liveModeConfirmCopy({ brokerLabel, broker });
  return (
    <ConfirmModal
      open={open}
      title={copy.title}
      confirmLabel={copy.confirmLabel}
      cancelLabel={copy.cancelLabel}
      tone="danger"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {copy.body.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </ConfirmModal>
  );
}
