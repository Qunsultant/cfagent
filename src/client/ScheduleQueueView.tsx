/**
 * Issue #3121 Slice S2 — the admin queue as a view of the schedules
 * home (`?tab=schedules&view=queue`).
 *
 * The queue (`AdminQueueWipePanel`) is a privileged operation even at
 * its first-class address, so this view preserves EXACTLY the
 * authorization that gated it inside IAAA Admin: the same probe
 * (`GET /api/iaaa/overview` via `fetchAdminOverview`), the same
 * 403/Forbidden → denied decision, and the same "Not an IAAA admin"
 * copy. The server is the gate; nothing client-side decides
 * authorization, and the wipe panel never mounts until the probe
 * passes.
 *
 * Deliberately NOT carried over: the IAAA limited view (#2688/#2836 —
 * role grants / logged-in users for tenant-admins). That view is
 * IAAA-specific; the queue wipe surface has no tenant-admin variant
 * ("a tenant-admin-gated wipe surface does not exist yet"), so a
 * tenant-admin who fails the overview probe is denied here, exactly
 * as a non-admin is. The wipe panel's own routes stay server-gated
 * behind this probe (defense in depth).
 */
import { useEffect, useState } from "react";
import { EmptyState, Notice, Spinner } from "./components/ui";
import { AdminQueueWipePanel } from "./AdminQueueWipePanel";
import { fetchAdminOverview } from "./iaaaAdminApi";

/** The same gate test IaaaAdminPanel uses: a 403/Forbidden overview refusal means "not an admin". */
export function isOverviewGateRefusal(message: string): boolean {
  return /403|Forbidden/.test(message);
}

export function ScheduleQueueView() {
  const [gate, setGate] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchAdminOverview()
      .then(() => {
        if (!cancelled) setGate("allowed");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load IAAA overview.";
        if (isOverviewGateRefusal(message)) {
          setGate("denied");
        } else {
          setError(message);
          setGate("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (gate === "loading") return <Spinner />;
  if (gate === "denied") {
    return (
      <EmptyState
        title="Not an IAAA admin"
        description="This panel is only available to platform admins. If you should have access, sign in with an admin account."
      />
    );
  }
  if (gate === "error") return <Notice tone="danger">{error}</Notice>;
  return <AdminQueueWipePanel />;
}
