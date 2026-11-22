/** @vitest-environment jsdom */

/**
 * Issue #3261 — Profile section, rendered for real (react-dom, not
 * source-text assertions).
 *
 * The profileApi module is mocked at the network boundary only (the
 * checkout-panel precedent): the section's own logic — load, edit,
 * save, coded messages, field errors, idempotency-key reuse — runs
 * for real.
 *
 * Governing rule, tested here: display name + phone + contact
 * email, all editable. The login is shown read-only (it IS the
 * verified identity) and never changes when the contact email
 * changes. An unset display name shows as the login (PROPOSED
 * default, display-only).
 *
 * AOP amendment: every message the section renders comes from the
 * server's coded response — tests assert the message FROM the
 * catalog (getOutcome), never a hardcoded string. A 400 names its
 * field, and the section marks that field invalid (aria-invalid +
 * the coded message under it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProfileSection } from "../src/client/ProfileSection";
import {
  displayNameFor,
  ProfileApiError,
  type UserProfileView,
} from "../src/client/profileApi";
import { PROFILE_LIMITS } from "../src/config/profileLimits";
import { getOutcome } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const catalogMessage = (code: string): string => getOutcome(code)!.businessMessage;

// Issue #6141: the profile section now mounts the referral panel,
// which fetches GET /referral/balance on mount. The stub answers
// that read with an empty extension summary, so the panel renders
// its content instead of a load warning (which would add a second
// role="alert" to the container and break the duplicate-save test).
const REFERRAL_BALANCE = {
  code: "SUCCESS_REFERRAL_BALANCE_READ",
  userId: "prof-ui-a",
  redeemableUSD: 0,
  expiredUSD: 0,
  totalEarnedUSD: 0,
  attribution: null,
  extension: {
    referredCount: 0,
    totalExtensionDays: 0,
    appliedDays: 0,
    bankedDays: 0,
    expiredDays: 0,
    trialEndsAtMs: null,
  },
  rules: {
    earnAmountUSD: 0.5,
    vestingDelayMs: 604800000,
    redemptionScope: "pay-per-run",
    expiryPeriodMs: 7776000000,
    extensionDays: 7,
    referredTrialDays: 14,
    maxExtensionsPerDay: 3,
    maxExtensionsPerMonth: 10,
    referralTrialPlanId: null,
    shareMessageTemplate:
      "Join me on OpenAIMP — sign up with my link and get a {trialDays}-day free trial of the paid tier, plus free runs every month: {link}",
  },
};

const prevFetch = (globalThis as any).fetch;

const apiState = vi.hoisted(() => ({
  profile: {
    userLogin: "prof-ui-a",
    displayName: null,
    phone: null,
    email: null,
    updatedAtMs: null,
  } as UserProfileView,
  fetchError: null as null | Error,
  saveCalls: [] as { input: Record<string, unknown>; key: string }[],
  saveError: null as null | Error,
  saveDuplicate: false,
  saveMessage: null as null | string,
}));

vi.mock("../src/client/profileApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/profileApi")>();
  return {
    ...actual,
    fetchProfile: vi.fn(async () => {
      if (apiState.fetchError) throw apiState.fetchError;
      return apiState.profile;
    }),
    saveProfile: vi.fn(async (input: Record<string, unknown>, key: string) => {
      apiState.saveCalls.push({ input, key });
      if (apiState.saveError) throw apiState.saveError;
      const next: UserProfileView = {
        userLogin: apiState.profile.userLogin,
        displayName:
          input.displayName === undefined ? apiState.profile.displayName : (input.displayName as string | null),
        phone: input.phone === undefined ? apiState.profile.phone : (input.phone as string | null),
        email: input.email === undefined ? apiState.profile.email : (input.email as string | null),
        updatedAtMs: 1234,
      };
      apiState.profile = next;
      return {
        profile: next,
        message: apiState.saveMessage ?? catalogMessage("SUCCESS_PROFILE_UPDATED"),
        duplicate: apiState.saveDuplicate,
      };
    }),
  };
});

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll("label"));
  const match = labels.find((l) => l.textContent?.includes(label));
  expect(match).toBeDefined();
  const control = match!.parentElement?.querySelector("input") as HTMLInputElement | null;
  expect(control).toBeDefined();
  return control!;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderSection(userLogin = "prof-ui-a"): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ProfileSection userLogin={userLogin} />);
  });
  await flush();
  return { container, root };
}

function clickSave(container: HTMLElement) {
  const save = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Save profile"),
  );
  expect(save).toBeDefined();
  return act(async () => {
    save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  apiState.profile = { userLogin: "prof-ui-a", displayName: null, phone: null, email: null, updatedAtMs: null };
  apiState.fetchError = null;
  apiState.saveCalls = [];
  apiState.saveError = null;
  apiState.saveDuplicate = false;
  apiState.saveMessage = null;
  document.body.innerHTML = "";
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/referral/balance")) {
      return { ok: true, status: 200, json: async () => REFERRAL_BALANCE };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  (globalThis as any).fetch = prevFetch;
});

describe("displayNameFor (#3261)", () => {
  it("shows the login when no display name is set, and the display name when it is", () => {
    expect(
      displayNameFor({ userLogin: "prof-ui-a", displayName: null, phone: null, email: null, updatedAtMs: null }),
    ).toBe("prof-ui-a");
    expect(
      displayNameFor({ userLogin: "prof-ui-a", displayName: "Ada", phone: null, email: null, updatedAtMs: 1 }),
    ).toBe("Ada");
  });
});

describe("ProfileSection (#3261)", () => {
  it("renders the login read-only with empty fields, and saves trimmed values with the server's coded message", async () => {
    const { container } = await renderSection();
    expect(container.textContent).toContain("Signed in as:");
    expect(container.textContent).toContain("prof-ui-a");
    const nameInput = inputByLabel(container, "Display name");
    const phoneInput = inputByLabel(container, "Phone");
    const emailInput = inputByLabel(container, "Email");
    expect(nameInput.value).toBe("");
    expect(phoneInput.value).toBe("");
    expect(emailInput.value).toBe("");
    // Length hints come from the config, not a second hardcoded copy.
    expect(nameInput.maxLength).toBe(PROFILE_LIMITS.displayNameMaxLength);
    expect(phoneInput.maxLength).toBe(PROFILE_LIMITS.phoneMaxLength);
    expect(emailInput.maxLength).toBe(PROFILE_LIMITS.emailMaxLength);

    setInputValue(nameInput, "  Ada Lovelace  ");
    setInputValue(phoneInput, " +1 555-0100 ");
    setInputValue(emailInput, "  ada@example.com  ");
    await clickSave(container);
    await flush();
    expect(apiState.saveCalls).toHaveLength(1);
    expect(apiState.saveCalls[0].input).toEqual({ displayName: "Ada Lovelace", phone: "+1 555-0100", email: "ada@example.com" });
    expect(apiState.saveCalls[0].key.length).toBeGreaterThan(0);
    expect(container.textContent).toContain(catalogMessage("SUCCESS_PROFILE_UPDATED"));
    // The confirmation announces via role="status" (the Notice primitive).
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      catalogMessage("SUCCESS_PROFILE_UPDATED"),
    );
  });

  it("prefills saved values, and clearing the display name sends null", async () => {
    apiState.profile = {
      userLogin: "prof-ui-a",
      displayName: "Ada",
      phone: "+1 555-0100",
      email: "ada@example.com",
      updatedAtMs: 100,
    };
    const { container } = await renderSection();
    expect(inputByLabel(container, "Display name").value).toBe("Ada");
    expect(inputByLabel(container, "Phone").value).toBe("+1 555-0100");
    expect(inputByLabel(container, "Email").value).toBe("ada@example.com");
    expect(container.textContent).toContain("showing as Ada");

    setInputValue(inputByLabel(container, "Display name"), "   ");
    setInputValue(inputByLabel(container, "Email"), "   ");
    await clickSave(container);
    await flush();
    expect(apiState.saveCalls[0].input).toEqual({ displayName: null, phone: "+1 555-0100", email: null });
  });

  it("renders an email field with the login-unchanged hint, and never offers a login change", async () => {
    const { container } = await renderSection();
    const labels = Array.from(container.querySelectorAll("label")).map((l) => l.textContent ?? "");
    expect(labels.join(" ")).toMatch(/email/i);
    // Issue #6141: the referral panel adds a fourth input (the
    // read-only referral link) below the profile fields.
    expect(container.querySelectorAll("input").length).toBe(4);
    expect(container.textContent).toContain("does not change your sign-in login");
    expect(container.textContent).not.toContain("Email cannot be changed here yet");
  });

  it("shows the server's coded message when loading fails, with a retry", async () => {
    apiState.fetchError = new ProfileApiError(
      catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"),
      "FAILURE_PROFILE_STORE_UNAVAILABLE",
      503,
    );
    const { container } = await renderSection();
    expect(container.textContent).toContain(catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"));
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Try again")),
    ).toBe(true);
  });

  it("marks the failing field invalid with the coded message on a 400, and no generic error", async () => {
    apiState.saveError = new ProfileApiError(
      catalogMessage("FAILURE_PROFILE_VALIDATION"),
      "FAILURE_PROFILE_VALIDATION",
      400,
      "phone",
    );
    const { container } = await renderSection();
    await clickSave(container);
    await flush();
    const phoneInput = inputByLabel(container, "Phone");
    expect(phoneInput.getAttribute("aria-invalid")).toBe("true");
    expect(inputByLabel(container, "Display name").getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).toContain(catalogMessage("FAILURE_PROFILE_VALIDATION"));
    expect(container.textContent).not.toContain(catalogMessage("SUCCESS_PROFILE_UPDATED"));
    expect(apiState.saveCalls).toHaveLength(1);
  });

  it("marks the email field invalid with the coded message on a 400 naming email", async () => {
    apiState.saveError = new ProfileApiError(
      catalogMessage("FAILURE_PROFILE_VALIDATION"),
      "FAILURE_PROFILE_VALIDATION",
      400,
      "email",
    );
    const { container } = await renderSection();
    await clickSave(container);
    await flush();
    const emailInput = inputByLabel(container, "Email");
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(inputByLabel(container, "Display name").getAttribute("aria-invalid")).toBeNull();
    expect(inputByLabel(container, "Phone").getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).toContain(catalogMessage("FAILURE_PROFILE_VALIDATION"));
    expect(apiState.saveCalls).toHaveLength(1);
  });

  it("shows the server's coded message for a non-field save failure", async () => {
    apiState.saveError = new ProfileApiError(
      catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"),
      "FAILURE_PROFILE_STORE_UNAVAILABLE",
      503,
    );
    const { container } = await renderSection();
    await clickSave(container);
    await flush();
    expect(container.textContent).toContain(catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"),
    );
    expect(container.textContent).not.toContain(catalogMessage("SUCCESS_PROFILE_UPDATED"));
  });

  it("shows the duplicate message (not an error) when the save had already landed", async () => {
    apiState.saveDuplicate = true;
    apiState.saveMessage = catalogMessage("FAILURE_PROFILE_DUPLICATE");
    const { container } = await renderSection();
    await clickSave(container);
    await flush();
    expect(container.textContent).toContain(catalogMessage("FAILURE_PROFILE_DUPLICATE"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      catalogMessage("FAILURE_PROFILE_DUPLICATE"),
    );
  });

  it("reuses the same idempotency key on retry, and mints a fresh one after a save lands", async () => {
    apiState.saveError = new ProfileApiError("network down", "", 0);
    const { container } = await renderSection();
    await clickSave(container);
    await flush();
    expect(apiState.saveCalls).toHaveLength(1);
    const firstKey = apiState.saveCalls[0].key;
    // The first attempt failed: the retry re-sends the same key.
    apiState.saveError = null;
    await clickSave(container);
    await flush();
    expect(apiState.saveCalls).toHaveLength(2);
    expect(apiState.saveCalls[1].key).toBe(firstKey);
    // The save landed, so the next save is a new attempt with a fresh key.
    setInputValue(inputByLabel(container, "Display name"), "Grace");
    await clickSave(container);
    await flush();
    expect(apiState.saveCalls).toHaveLength(3);
    expect(apiState.saveCalls[2].key).not.toBe(firstKey);
  });
});
