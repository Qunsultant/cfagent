/**
 * Issue #3256 (sub-issue of #3241, program #2218) — first-run gate
 * for the hub, now server-state aware. Extends #2471's gate: it
 * fetches the server onboarding state on mount and shows the screen
 * unless the server says completed, resuming at the saved step.
 *
 * Mounted once in Chat. It renders nothing when this user already
 * completed first-run (server state, or the #2471 localStorage flag
 * as fallback) or dismissed setup for this session. Otherwise it
 * shows the FirstRunScreen in a Modal over the hub. Dismissal
 * (Escape, backdrop, or Continue to hub) is session-only: it never
 * marks completion, so setup shows again on the next login until
 * the user finishes it. Completion (Finish) marks the per-user flag
 * and hides the gate from then on.
 *
 * The gate never blocks the hub on a load failure: when the server
 * state route fails, the #2471 localStorage flag decides (a user
 * who completed on this device stays hidden; anyone else sees the
 * screen from step 1), so a broken state endpoint degrades to an
 * unguided hub, not a bricked one. A user with no server row and no
 * local flag is a fresh login — the screen shows from step 1, which
 * is also the cross-device behavior until server completion exists.
 */
import React, { useEffect, useState } from "react";
import { Modal } from "./components/ui";
import { FirstRunScreen } from "./FirstRunScreen";
import { fetchOnboardingState, isFirstRunComplete } from "./firstRunApi";

export interface FirstRunGateProps {
  userLogin: string;
  /** Called when the user asks to see subscription plans (checkout tab). Dismisses the modal first. */
  onOpenCheckout?: () => void;
}

export function FirstRunGate({ userLogin, onOpenCheckout }: FirstRunGateProps) {
  const [dismissed, setDismissed] = useState(false);
  const [completed, setCompleted] = useState(() =>
    userLogin ? isFirstRunComplete(userLogin) : true,
  );
  const [initialStep, setInitialStep] = useState(1);

  useEffect(() => {
    if (!userLogin) return;
    let cancelled = false;
    (async () => {
      try {
        const state = await fetchOnboardingState();
        if (cancelled) return;
        if (state && state.completedAtMs !== null) {
          setCompleted(true);
        } else if (state && state.completedAtMs === null) {
          // Server state exists and is unfinished: it is the
          // authority — resume at the saved step even if this
          // device once recorded a local completion.
          setCompleted(false);
          setInitialStep(state.currentStep);
        }
        // No server row: the localStorage flag (initial state)
        // decides, exactly as #2471.
      } catch {
        // State route failed: fall back to the localStorage flag.
        // Never brick the hub on a state-store failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userLogin]);

  if (!userLogin || dismissed || completed) return null;

  return (
    <Modal
      open
      title="Welcome — first-run setup"
      onClose={() => setDismissed(true)}
      size="lg"
    >
      <FirstRunScreen
        userLogin={userLogin}
        initialStep={initialStep}
        onComplete={() => setCompleted(true)}
        onDismiss={() => setDismissed(true)}
        onOpenCheckout={
          onOpenCheckout
            ? () => {
                setDismissed(true);
                onOpenCheckout();
              }
            : undefined
        }
      />
    </Modal>
  );
}
