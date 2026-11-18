/**
 * Issue #4260 ([3121] surface the scheduling-channel flags in the
 * schedules home): the flags section of the schedules home. It reads
 * the three surfaced flags live from GET /api/schedules/flags
 * (through the existing FeatureFlagPort, server-side) and lets a
 * platform admin toggle the two channel flags through POST
 * /api/schedules/flags. The one-on invariant is enforced server-side
 * (both-off refused with SCHEDULE_CHANNELS_BOTH_OFF); non-admins see
 * the state read-only; when the runtime's flag source is
 * operator-owned (Flagship dashboard / env vars) the toggle is
 * disabled and the panel names where the flag is managed instead.
 * No second flag store: the panel is a surface over the port, not a
 * store. Primitives only (Card, CardHeader, Badge, Button,
 * Notice, Spinner) with token styling — no raw HTML controls.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, CardHeader, Flex, Notice, Spinner, Stack } from "./components/ui";
import type { ScheduleChannelFlagsView } from "../features/scheduleChannelFlags";

export type ScheduleChannelFlagsManagedBy = "flagship" | "environment" | "in-memory";

export interface ScheduleChannelFlagsViewResponse extends ScheduleChannelFlagsView {
  canToggle: boolean;
  managedBy: ScheduleChannelFlagsManagedBy;
}

const MANAGED_BY_LABEL: Record<ScheduleChannelFlagsManagedBy, string> = {
  flagship: "Cloudflare Flagship dashboard",
  environment: "environment variables (FEATURE_FLAGS / FEATURE_SCHEDULE_CHAT / FEATURE_SCHEDULE_NLQ) + redeploy",
  "in-memory": "the in-memory flag runtime",
};

export async function fetchScheduleChannelFlags(
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleChannelFlagsViewResponse> {
  const res = await fetchImpl("/api/schedules/flags");
  if (!res.ok) {
    throw new Error(`Reading the scheduling-channel flags failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as ScheduleChannelFlagsViewResponse;
}

export interface ScheduleChannelFlagsPanelProps {
  /**
   * Test/SSR seam: a preloaded view. When absent the panel fetches
   * GET /api/schedules/flags on mount.
   */
  initialView?: ScheduleChannelFlagsViewResponse | null;
}

export function ScheduleChannelFlagsPanel({ initialView = null }: ScheduleChannelFlagsPanelProps = {}) {
  const [view, setView] = useState<ScheduleChannelFlagsViewResponse | null>(initialView);
  const [loading, setLoading] = useState(initialView === null);
  const [error, setError] = useState<string | null>(null);
  const [busyFlag, setBusyFlag] = useState<string | null>(null);

  useEffect(() => {
    if (initialView !== null) return;
    let cancelled = false;
    setLoading(true);
    fetchScheduleChannelFlags()
      .then((loaded) => {
        if (!cancelled) {
          setView(loaded);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialView]);

  const handleToggle = useCallback(
    async (flag: string, enabled: boolean) => {
      setBusyFlag(flag);
      setError(null);
      try {
        const res = await fetch("/api/schedules/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flag, enabled }),
        });
        const body = (await res.json().catch(() => null)) as
          | (ScheduleChannelFlagsViewResponse & { error?: string; code?: string })
          | null;
        if (!res.ok || !body) {
          throw new Error(
            (body && body.error) || `Toggling ${flag} failed (HTTP ${res.status}).`,
          );
        }
        setView(body);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyFlag(null);
      }
    },
    [],
  );

  if (loading) {
    return <Spinner label="Loading scheduling-channel flags…" />;
  }
  if (!view) {
    return (
      <Notice tone="danger" title="Scheduling-channel flags unavailable">
        {error ?? "The flags could not be read."}
      </Notice>
    );
  }

  const canToggle = view.canToggle && view.writable;
  return (
    <div>
      <CardHeader
        title="Scheduling channel flags"
        meta={
          <span className="ui-meta-sm">
            Live state from the feature-flag port — chat first, then NLQ. Managed in{" "}
            {MANAGED_BY_LABEL[view.managedBy]}.
          </span>
        }
      />
      {error && (
        <Notice tone="danger" title="Flag change refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {!view.canToggle && (
        <Notice tone="neutral" title="Read-only">
          These flags are read-only for your session — only a platform admin can change
          them.
        </Notice>
      )}
      {view.canToggle && !view.writable && (
        <Notice tone="warning" title="Managed outside this runtime">
          This runtime reads the flags from {MANAGED_BY_LABEL[view.managedBy]}, so the
          toggles are disabled here — change them where the flag is managed instead.
        </Notice>
      )}
      <Stack gap="3">
        {view.flags.map((entry) => (
          <Flex key={entry.flag} justify="between" align="center" gap="2">
            <Stack gap="1" className="ui-grow">
              <div>
                {entry.label}{" "}
                <span className="ui-meta-sm">{entry.flag}</span>
              </div>
              <div className="ui-meta-sm">
                {entry.toggleable
                  ? entry.defaultValue === null
                    ? "Channel flag"
                    : `Channel flag — default ${entry.defaultValue ? "ON" : "OFF"}`
                  : "Gates the schedules home itself — read-only here"}
              </div>
            </Stack>
            <Badge tone={entry.enabled ? "success" : "neutral"} dot>
              {entry.enabled ? "ON" : "OFF"}
            </Badge>
            {entry.toggleable && (
              <Button
                variant="secondary"
                size="sm"
                tone={entry.enabled ? "solid" : "subtle"}
                aria-pressed={entry.enabled}
                disabled={!canToggle || busyFlag === entry.flag}
                onClick={() => void handleToggle(entry.flag, !entry.enabled)}
              >
                {entry.enabled ? "Turn off" : "Turn on"}
              </Button>
            )}
          </Flex>
        ))}
      </Stack>
    </div>
  );
}
