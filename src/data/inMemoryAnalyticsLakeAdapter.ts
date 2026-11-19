/**
 * In-memory analytics lake — the test double and the inert default.
 *
 * With `accept: false` it is the "lake is off" adapter: every event is
 * dropped with a reason, so a caller can be wired unconditionally and still
 * report honestly that nothing was archived.
 */
import type {
  AnalyticsLakePort,
  LakeAppendResult,
  LakeEvent,
} from "./analyticsLakePorts";

export class InMemoryAnalyticsLakeAdapter implements AnalyticsLakePort {
  readonly events: LakeEvent[] = [];

  constructor(
    private readonly opts: { accept?: boolean; reason?: string } = {},
  ) {}

  async append(events: readonly LakeEvent[]): Promise<LakeAppendResult> {
    if (this.opts.accept === false) {
      return {
        accepted: 0,
        dropped: events.length,
        reason: this.opts.reason ?? "analytics_lake_off",
      };
    }
    this.events.push(...events);
    return { accepted: events.length, dropped: 0 };
  }
}
