/** @vitest-environment jsdom */
/**
 * Issue #3574 — WCAG 2.2 AA evidence pass for the Top up journey.
 *
 * Harness follows tests/checkout_ui_top_up_3262.test.tsx: react-dom/client
 * in jsdom, direct component renders, stubbed fetch. The Top up tab
 * (?checkoutTab=topup) is exercised end to end: amount → pay → credited →
 * status, in pass and failure states.
 *
 * What this file pins (tech-standards §10: automated checks are necessary
 * but insufficient — the journey assessment itself is recorded in the PR
 * body):
 *  - field association: client-side validation errors render on their
 *    field (aria-invalid + aria-describedby → the field error span) and
 *    focus moves to the first invalid field;
 *  - server failures stay a form-level alert (role="alert"), never a field
 *    error; the credited milestone is a status announcement (role="status");
 *  - tablist/tabpanel wiring resolves (aria-controls → an existing panel);
 *  - the checkout link is a token link that names the new tab;
 *  - keyboard order: no positive tabindex, no unreachable controls;
 *  - contrast: the journey's text pairs (≥4.5:1) and non-text pairs (≥3:1)
 *    computed from the same tokens prod uses, in all three themes — with
 *    the known 1.4.11 token gaps pinned as documented known-fails (see
 *    FOLLOW_UP below);
 *  - target sizes: the primitives' declared sizes meet the 24px AA minimum
 *    and the tab uses the default (md) sizes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckoutPanel } from "../src/client/CheckoutPanel";
import { codedMessage } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Known 1.4.11 gaps, shared tokens — NOT fixed by this slice (the fix is a
 * token change shared by every input in the app, outside the Top up tab;
 * see the PR body). Pinned here so a token change that fixes them fails
 * loudly and this list moves to the passing assertions.
 * FOLLOW_UP: #3606 (filed under #3256 from this slice).
 */
const KNOWN_TOKEN_GAPS = "#3606 (1.4.11 input-border / light focus tokens)";

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function pricingVariant(over: Record<string, unknown> = {}) {
  return {
    monetizationEnabled: true,
    prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
    topUpLimits: { minUSD: 1, maxUSD: 500 },
    network: { stripeMode: "sandbox", x402Network: null, acceptsMainnet: false },
    browserPaymentScope: "card-only",
    failurePolicy: "One charge per run-request.",
    ...over,
  };
}

interface MockOpts {
  pricing?: Record<string, unknown>;
  checkout?: Record<string, unknown> | null;
  confirm?: Record<string, unknown> | { status: number } | null;
}

function mockFetch(opts: MockOpts = {}) {
  const pricing = opts.pricing ?? pricingVariant();
  const posts: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/payments/agentic/commercial/pricing") {
      return { ok: true, status: 200, json: async () => pricing } as any;
    }
    if (url === "/api/features") {
      return { ok: true, status: 200, json: async () => ({ features: { monetization: true } }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/identity") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userLogin: "u1",
          tenantId: "t1",
          hasAccount: true,
          tier: "Free",
          creditsUSD: 10,
          includedRunsRemaining: 0,
        }),
      } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: "u1", effectiveTier: "Free", current: null, subscriptions: [] }),
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/plans") {
      return { ok: true, status: 200, json: async () => ({ plans: [] }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/top-up/checkout" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts.checkout ?? {
            topUpRequestId: "topup-1",
            rail: "card",
            amountUSD: body.amountUSD,
            checkoutUrl: "https://checkout.stripe.com/pay/topup_1",
            checkoutSessionId: "cs_topup_1",
          },
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/top-up/confirm" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (opts.confirm && "status" in opts.confirm) {
        return { ok: false, status: opts.confirm.status, json: async () => ({ error: "typed server detail" }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts.confirm ?? {
            account: { creditsUSD: 35 },
            topUpRequestId: "topup-1",
            creditedUSD: 25,
            rail: "card",
          },
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts };
}

async function openTopUpTab() {
  await act(async () => {
    clickButton("Top up");
  });
  await flush();
}

function fieldErrorFor(input: HTMLInputElement): { describedBy: string | null; message: string | null } {
  const describedBy = input.getAttribute("aria-describedby");
  const message = describedBy ? (document.getElementById(describedBy)?.textContent ?? null) : null;
  return { describedBy, message };
}

function x402Pricing() {
  return pricingVariant({
    browserPaymentScope: "card-and-x402",
    network: { stripeMode: "sandbox", x402Network: "base-sepolia", acceptsMainnet: false },
  });
}

function x402Checkout() {
  return {
    topUpRequestId: "topup-2",
    rail: "x402",
    amountUSD: 25,
    checkoutId: "topup-2",
    challenge: {
      version: "1",
      network: "base-sepolia",
      recipient: "0x2222222222222222222222222222222222222222",
      amountUSD: 25,
      currency: "USDC",
      facilitator: "https://facilitator.example.invalid",
      resource: "top-up",
      nonce: "nonce-1",
      expiresAtMs: 1_800_000_100_000,
    },
  };
}

describe("top-up journey WCAG 2.2 AA (#3574)", () => {
  it("an amount below the minimum is a field error on the amount input and focuses it", async () => {
    const { posts } = mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "0.5");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const amount = inputForLabel("Amount (USD)");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    const { describedBy, message } = fieldErrorFor(amount);
    expect(describedBy).toBeTruthy();
    expect(message).toContain("Amount must be between $1.00 and $500.00.");
    expect(document.activeElement).toBe(amount);
    expect(inputForLabel("Checkout contact email").getAttribute("aria-invalid")).toBeNull();
    expect(posts.filter((p) => p.url.endsWith("/top-up/checkout"))).toHaveLength(0);
  });

  it("an empty amount is a field error on the amount input", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const amount = inputForLabel("Amount (USD)");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(fieldErrorFor(amount).message).toContain("Enter an amount greater than zero.");
    expect(document.activeElement).toBe(amount);
  });

  it("a missing email is a field error on the email input and focuses it", async () => {
    const { posts } = mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const email = inputForLabel("Checkout contact email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(fieldErrorFor(email).message).toContain("Enter the checkout contact email.");
    expect(document.activeElement).toBe(email);
    expect(inputForLabel("Amount (USD)").getAttribute("aria-invalid")).toBeNull();
    expect(posts.filter((p) => p.url.endsWith("/top-up/checkout"))).toHaveLength(0);
  });

  it("a missing x402 proof is a field error on the proof input and focuses it", async () => {
    const { posts } = mockFetch({ pricing: x402Pricing(), checkout: x402Checkout() });
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(select, "x402");
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    const proof = inputForLabel("Payment proof");
    expect(proof.getAttribute("aria-invalid")).toBe("true");
    expect(fieldErrorFor(proof).message).toContain("Paste the payment proof from your wallet or agent, then verify.");
    expect(document.activeElement).toBe(proof);
    expect(posts.filter((p) => p.url.endsWith("/top-up/confirm"))).toHaveLength(0);
  });

  it("a server failure on confirm stays a form-level alert, not a field error", async () => {
    mockFetch({ confirm: { status: 402 } });
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The checkout is not paid yet. Complete the payment, then try again.");
    for (const input of Array.from(container.querySelectorAll("input"))) {
      expect(input.getAttribute("aria-invalid")).toBeNull();
    }
  });

  it("the credited milestone is a status announcement with no field errors", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    const statuses = Array.from(container.querySelectorAll('[role="status"]'));
    // Issue #3571: the credited milestone renders the catalog message for
    // SUCCESS_TOP_UP_CREDITED (via codedMessage) plus the amounts as data —
    // the old hand-written "Top-up credited: $25.00. New credit balance:
    // $35.00." sentence is gone. The pin still asserts the milestone is a
    // status announcement carrying the credited amount and new balance.
    expect(
      statuses.some((s) =>
        (s.textContent || "").includes(
          `${codedMessage("SUCCESS_TOP_UP_CREDITED")} Credited $25.00 — new balance $35.00.`,
        ),
      ),
    ).toBe(true);
    for (const input of Array.from(container.querySelectorAll("input"))) {
      expect(input.getAttribute("aria-invalid")).toBeNull();
    }
  });

  it("the tablist/tabpanel wiring resolves for the Top up tab", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent || "").trim() === "Top up",
    ) as HTMLButtonElement;
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const panelId = tab.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute("role")).toBe("tabpanel");
    expect(panel!.getAttribute("aria-labelledby")).toBe(tab.id);
    // Roving tabindex: the selected tab is the only tab stop in the list.
    for (const t of Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]) {
      expect(t.tabIndex).toBe(t === tab ? 0 : -1);
    }
  });

  it("the checkout link is a token link that names the new tab", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const link = container.querySelector('a[href="https://checkout.stripe.com/pay/topup_1"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.classList.contains("ui-link")).toBe(true);
    expect(link.textContent).toContain("Complete payment (opens in a new tab)");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("keyboard order has no positive tabindex and no unreachable controls", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const focusables = Array.from(
      container.querySelectorAll("button, input, select, a[href], [tabindex]"),
    ) as HTMLElement[];
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) {
      expect(el.tabIndex).toBeLessThanOrEqual(0);
      expect(el.tabIndex).toBeGreaterThanOrEqual(-1);
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
        expect(el.disabled).toBe(false);
      }
    }
    // The tab order is the DOM order (no positive tabindex anywhere).
    expect(focusables.some((el) => el.tabIndex > 0)).toBe(false);
  });

  it("the tab uses the default (md) primitive sizes", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    for (const btn of Array.from(container.querySelectorAll(".ui-btn"))) {
      expect(btn.classList.contains("size-md")).toBe(true);
    }
    for (const input of Array.from(container.querySelectorAll(".ui-input, .ui-select"))) {
      expect(input.classList.contains("size-md")).toBe(true);
    }
    expect(container.querySelector(".ui-tabs")?.classList.contains("size-md")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Contrast + target-size evidence, computed from the shipped tokens.  */
/* Same parsing approach as tests/ux_indicator_contrast.test.ts:       */
/* translucent layers are composited over the effective background —  */
/* the Card the tab's notices sit in — before the ratio is computed.  */
/* ------------------------------------------------------------------ */

const ROOT = join(__dirname, "..");
const CSS_PATH = join(ROOT, "src", "client", "tokens.css");
const PRIMITIVES_PATH = join(ROOT, "src", "client", "components", "ui", "primitives.css");

const cssText = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function extractBlock(css: string, selectorRe: RegExp): Record<string, string> {
  const m = css.match(selectorRe);
  if (!m || m.index === undefined) return {};
  const start = css.indexOf("{", m.index);
  let depth = 0;
  let end = start;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = css.slice(start + 1, end);
  const vars: Record<string, string> = {};
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
  return vars;
}

const THEMES: Record<string, Record<string, string>> = {
  dark: extractBlock(cssText, /:root,\s*\[data-theme="dark"\]/),
  light: extractBlock(cssText, /\[data-theme="light"\]/),
  "high-contrast": extractBlock(cssText, /\[data-theme="high-contrast"\]/),
};

function resolveVar(vars: Record<string, string>, name: string, seen = new Set<string>()): string | undefined {
  const value = vars[name];
  if (value === undefined) return undefined;
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias && !seen.has(alias[1])) {
    seen.add(alias[1]);
    return resolveVar(vars, alias[1], seen);
  }
  return value;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const shadow = value.match(/rgba?\([^)]*\)/);
  const v = shadow ? shadow[0] : value;
  const hex = v.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = v.match(/^rgba?\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[1].split(",").map((s) => s.trim());
    return { r: +parts[0], g: +parts[1], b: +parts[2], a: parts[3] === undefined ? 1 : parseFloat(parts[3]) };
  }
  return null;
}

function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return fg;
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function colorOf(vars: Record<string, string>, name: string): Rgba {
  const c = parseColor(resolveVar(vars, name));
  if (!c) throw new Error(`Unresolvable token: ${name}`);
  return c;
}

/** Composite a stack of tokens top-to-bottom over the named base token. */
function effective(vars: Record<string, string>, base: string, ...layers: string[]): Rgba {
  let acc = colorOf(vars, base);
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    acc = compositeOver(colorOf(vars, layers[i]), acc);
  }
  return acc;
}

/**
 * A border (or focus ring) is opaque paint sitting ON an adjacent surface,
 * not a fill layered under one: its displayed color is the token composited
 * over that adjacent background. (Layering it under the input fill — the
 * mistake `effective(card, input, border)` makes — collapses to the fill
 * itself and measures ~1.0:1.)
 */
function paintOver(vars: Record<string, string>, token: string, bg: Rgba): Rgba {
  return compositeOver(colorOf(vars, token), bg);
}

function ratio(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = luminance(fg) >= luminance(bg) ? [luminance(fg), luminance(bg)] : [luminance(bg), luminance(fg)];
  return (hi + 0.05) / (lo + 0.05);
}

describe("top-up journey contrast + target sizes (#3574)", () => {
  it("journey text pairs meet WCAG AA 4.5:1 in all three themes", () => {
    for (const [theme, vars] of Object.entries(THEMES)) {
      const card = colorOf(vars, "--color-card");
      const surface = colorOf(vars, "--color-surface");
      const pairs: Array<[string, Rgba, Rgba]> = [
        ["field error on card", colorOf(vars, "--color-danger-text"), card],
        ["field error on surface", colorOf(vars, "--color-danger-text"), surface],
        ["hint on card", colorOf(vars, "--color-text-dim"), card],
        ["hint on surface", colorOf(vars, "--color-text-dim"), surface],
        ["label on card", colorOf(vars, "--color-text-secondary"), card],
        ["input text", colorOf(vars, "--color-input-foreground"), effective(vars, "--color-card", "--color-input")],
        [
          "notice info text",
          colorOf(vars, "--color-info-text"),
          effective(vars, "--color-card", "--color-info-subtle"),
        ],
        [
          "notice danger text",
          colorOf(vars, "--color-danger-text"),
          effective(vars, "--color-card", "--color-danger-subtle"),
        ],
        [
          "notice success text",
          colorOf(vars, "--color-success-text"),
          effective(vars, "--color-card", "--color-success-subtle"),
        ],
        ["button text", colorOf(vars, "--color-primary-foreground"), colorOf(vars, "--color-primary")],
        [
          "checkout link",
          colorOf(vars, "--color-primary"),
          effective(vars, "--color-card", "--color-info-subtle"),
        ],
      ];
      for (const [label, fg, bg] of pairs) {
        const r = ratio(fg, bg);
        expect(r, `${theme}: ${label} (${r.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("non-text indicators meet WCAG AA 3:1 where the tokens allow it", () => {
    for (const [theme, vars] of Object.entries(THEMES)) {
      const card = colorOf(vars, "--color-card");
      const inputBg = effective(vars, "--color-card", "--color-input");
      const focusedBorderOnInput = paintOver(vars, "--color-border-focus", inputBg);
      const focusedBorderOnCard = paintOver(vars, "--color-border-focus", card);
      // Invalid-state boundary and the selected-tab indicator pass everywhere.
      expect(
        ratio(paintOver(vars, "--color-danger", inputBg), inputBg),
        `${theme}: invalid border vs input bg`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        ratio(colorOf(vars, "--color-accent"), colorOf(vars, "--color-surface")),
        `${theme}: selected tab accent vs surface`,
      ).toBeGreaterThanOrEqual(3);
      // Focused border passes in the default (dark) and high-contrast themes.
      if (theme !== "light") {
        expect(ratio(focusedBorderOnInput, inputBg), `${theme}: focused border vs input bg`).toBeGreaterThanOrEqual(3);
        expect(ratio(focusedBorderOnCard, card), `${theme}: focused border vs card`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it(`pins the known 1.4.11 token gaps below 3:1 (${KNOWN_TOKEN_GAPS})`, () => {
    // Documented known-fails: when the follow-up lands, move these pairs
    // to the passing assertions above.
    for (const [theme, vars] of Object.entries(THEMES)) {
      const card = colorOf(vars, "--color-card");
      const inputBg = effective(vars, "--color-card", "--color-input");
      const unfocusedBorder = paintOver(vars, "--color-input-border", inputBg);
      const focusedBorder = paintOver(vars, "--color-border-focus", inputBg);
      const ring = paintOver(vars, "--shadow-focus-ring", card);
      if (theme === "high-contrast") {
        expect(ratio(unfocusedBorder, inputBg), `${theme}: unfocused border vs input bg`).toBeGreaterThanOrEqual(3);
        expect(ratio(focusedBorder, inputBg), `${theme}: focused border vs input bg`).toBeGreaterThanOrEqual(3);
        expect(ratio(ring, card), `${theme}: focus ring vs card`).toBeGreaterThanOrEqual(3);
      } else {
        expect(ratio(unfocusedBorder, inputBg), `${theme}: unfocused border vs input bg`).toBeLessThan(3);
        expect(ratio(ring, card), `${theme}: focus ring vs card`).toBeLessThan(3);
        if (theme === "light") {
          expect(ratio(focusedBorder, inputBg), `${theme}: focused border vs input bg`).toBeLessThan(3);
        }
      }
    }
  });

  it("the primitives declare target sizes at or above the 24px AA minimum", () => {
    const primitives = readFileSync(PRIMITIVES_PATH, "utf8");
    const minHeight = (selector: string): number => {
      const m = primitives.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*min-height:\\s*([0-9.]+)px`));
      if (!m) throw new Error(`No min-height found for ${selector}`);
      return parseFloat(m[1]);
    };
    expect(minHeight(".ui-btn.size-md")).toBeGreaterThanOrEqual(24);
    expect(minHeight(".ui-btn.size-sm")).toBeGreaterThanOrEqual(24);
    // Inputs and tabs carry no min-height; their height comes from vertical
    // padding + 14px text: input-md --space-2 (8px) top/bottom, tab-md
    // --space-3 (12px) top/bottom — both clear 24px at any line-height ≥ 1.
    // (#3135 tokenized the raw rem paddings; vPad resolves var(--space-*)
    // through the frozen scale in tokens.css instead of parsing a raw rem.)
    const spacePx = (name: string): number => {
      const m = cssText.match(new RegExp(`--${name}:\\s*([0-9.]+)rem`));
      if (!m) throw new Error(`No space token --${name} in tokens.css`);
      return parseFloat(m[1]) * 16;
    };
    const vPad = (selector: string): number => {
      const m = primitives.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*padding:\\s*(?:([0-9.]+)rem|var\\((--[\\w-]+)\\))`),
      );
      if (!m) throw new Error(`No padding found for ${selector}`);
      if (m[1] !== undefined) return parseFloat(m[1]) * 16;
      if (m[2].startsWith("--space-")) return spacePx(m[2].slice(2));
      throw new Error(`Unsupported padding token ${m[2]} for ${selector}`);
    };
    expect(2 * vPad(".ui-input.size-md") + 14).toBeGreaterThanOrEqual(24);
    expect(2 * vPad(".ui-tabs.size-md .ui-tab") + 14).toBeGreaterThanOrEqual(24);
  });
});
