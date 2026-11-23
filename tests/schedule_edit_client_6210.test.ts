/**
 * Issue #6210 — schedule edit is not atomic.
 *
 * Client half: the screening schedule form's edit save cancelled the
 * existing schedule FIRST and only then created the replacement, so
 * a create refused for a missing account binding deleted the only
 * stock schedule. `saveEditedSchedule` creates FIRST and cancels the
 * old schedule only after the create succeeds, so a refused create
 * leaves the original untouched. Pinned here with fake create/cancel.
 */
import { describe, it, expect, vi } from "vitest";
import { saveEditedSchedule } from "../src/client/scheduledOptionsManager/scheduleEdit";

const BINDING_ERROR =
  "Schedule action failed [FAILURE_ACCOUNT_BINDING_MISSING] No account binding is configured for this broker, mode, and surface.";

describe("6210 saveEditedSchedule creates before it cancels", () => {
  it("a refused create never cancels the original schedule", async () => {
    const create = vi.fn(async () => ({ success: false as const, error: BINDING_ERROR }));
    const cancel = vi.fn(async () => ({ cancelled: true }));

    const result = await saveEditedSchedule({ create, cancel }, "old-1", { intervalSeconds: 3600 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a thrown create never cancels the original schedule", async () => {
    const create = vi.fn(async () => {
      throw new Error("network down");
    });
    const cancel = vi.fn(async () => ({ cancelled: true }));

    const result = await saveEditedSchedule({ create, cancel }, "old-1", { intervalSeconds: 3600 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a successful create cancels the old schedule once", async () => {
    const create = vi.fn(async () => ({ success: true as const, schedule: { id: "new-9" } }));
    const cancel = vi.fn(async () => ({ cancelled: true }));

    const result = await saveEditedSchedule({ create, cancel }, "old-1", { intervalSeconds: 3600 });

    expect(result).toEqual({ ok: true, scheduleId: "new-9" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("old-1");
  });

  it("a duplicate-suppressed create (same id) cancels nothing", async () => {
    const create = vi.fn(async () => ({ success: true as const, schedule: { id: "old-1" } }));
    const cancel = vi.fn(async () => ({ cancelled: true }));

    const result = await saveEditedSchedule({ create, cancel }, "old-1", { intervalSeconds: 20160 });

    expect(result).toEqual({ ok: true, scheduleId: "old-1" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a failed post-create cancel names the leftover old schedule", async () => {
    const create = vi.fn(async () => ({ success: true as const, schedule: { id: "new-9" } }));
    const cancel = vi.fn(async () => {
      throw new Error("cancel rejected");
    });

    const result = await saveEditedSchedule({ create, cancel }, "old-1", { intervalSeconds: 3600 });

    expect(result.ok).toBe(true);
    expect(result.scheduleId).toBe("new-9");
    expect(result.warning).toContain("old-1");
    expect(result.warning).toContain("could not be removed");
  });

  it("a create with no schedule to replace cancels nothing", async () => {
    const create = vi.fn(async () => ({ success: true as const, schedule: { id: "new-9" } }));
    const cancel = vi.fn(async () => ({ cancelled: true }));

    const result = await saveEditedSchedule({ create, cancel }, null, { intervalSeconds: 3600 });

    expect(result).toEqual({ ok: true, scheduleId: "new-9" });
    expect(cancel).not.toHaveBeenCalled();
  });
});
