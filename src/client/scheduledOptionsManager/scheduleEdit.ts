/**
 * Issue #6210 — the screening schedule form's edit save, extracted
 * from ScheduledOptionsManager so the ordering is testable.
 *
 * The old save cancelled the schedule being edited FIRST and only
 * then created its replacement, so a create refused for a missing
 * account binding deleted the schedule (four saves, four cancels,
 * zero recreates — the only stock schedule, 2026-11-23). This helper
 * creates FIRST and cancels the old schedule only after the create
 * succeeds, so a refused create leaves the original untouched and
 * the binding error is shown before any cancel happens.
 *
 * The create route validates everything (including the account
 * binding) before arming, so a create that succeeds has already
 * passed every check the old cancel-first order was racing.
 */
export interface ScheduleEditCreateResult {
  success?: boolean;
  schedule?: { id: string };
  error?: string;
}

export interface ScheduleEditDeps {
  create: (body: unknown) => Promise<ScheduleEditCreateResult>;
  cancel: (id: string) => Promise<{ cancelled: boolean }>;
}

export interface ScheduleEditResult {
  ok: boolean;
  scheduleId?: string;
  error?: string;
  /** The replacement is live but the old schedule could not be removed. */
  warning?: string;
}

export async function saveEditedSchedule(
  deps: ScheduleEditDeps,
  editingScheduleId: string | null,
  body: unknown,
): Promise<ScheduleEditResult> {
  let created: ScheduleEditCreateResult;
  try {
    created = await deps.create(body);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!created.success) {
    return { ok: false, error: created.error || "Failed to save schedule" };
  }
  const scheduleId = created.schedule?.id;
  if (!scheduleId) {
    return { ok: false, error: "Failed to save schedule" };
  }
  if (!editingScheduleId || scheduleId === editingScheduleId) {
    // No schedule to replace, or the create suppressed a duplicate
    // and returned the schedule being edited: cancel nothing.
    return { ok: true, scheduleId };
  }
  try {
    const cancelled = await deps.cancel(editingScheduleId);
    if (!cancelled.cancelled) {
      return {
        ok: true,
        scheduleId,
        warning: `The new schedule was saved, but the previous schedule ${editingScheduleId} could not be removed — remove it manually.`,
      };
    }
  } catch (err) {
    return {
      ok: true,
      scheduleId,
      warning: `The new schedule was saved, but the previous schedule ${editingScheduleId} could not be removed (${err instanceof Error ? err.message : String(err)}) — remove it manually.`,
    };
  }
  return { ok: true, scheduleId };
}
