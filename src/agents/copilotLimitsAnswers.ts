/**
 * Issue #3889 — the copilot answers limits and refusals FROM THE TOOL OUTPUT,
 * not from the prompt.
 *
 * Why this module exists: the copilot used to paraphrase whatever the prompt
 * said about limits, which is how a refusal became "qty is not recognized" in
 * #3873. #3888 gave the platform one configuration surface; this module turns
 * that surface's tool payload into an answer, deterministically, so a test can
 * prove the numbers came from configuration and not from the model.
 *
 * Rules enforced here (and stated in the prompt):
 *   - every number is read from the returned snapshot; nothing is estimated;
 *   - each value names its source (ticker override / setting / env / unset);
 *   - an unset limit is "not configured", never a number;
 *   - a failed read is a failed read, naming the setting to fix;
 *   - a refusal answer quotes the code AND the four facts (limit, value, used,
 *     requested) via `describeTradingLimitRefusal`;
 *   - a cancel question is answered from the cancel receipt, and says so when
 *     no receipt was returned.
 */

import {
  type TradingLimitKey,
  type TradingLimitVerdict,
  type TradingLimitsSnapshot,
  TRADING_LIMIT_KEYS,
  describeTradingLimitRefusal,
  formatTradingLimitAmount,
  tradingLimitEnvVar,
} from "../trading";

export type TradingLimitQuestion = "what_are_my_limits" | "why_refused" | "budget_left" | "what_did_you_stop";

export interface CancelReceiptSummary {
  action?: string;
  targeted?: number;
  cancelled?: Array<{ orderId: string; symbol?: string; statusAfter?: string | null }>;
  refused?: Array<{ orderId: string; message: string }>;
  message?: string;
}

export interface LimitAnswerInput {
  question: TradingLimitQuestion;
  symbol?: string | null;
  /** The `trading_limits` payload, verbatim. Missing means the read failed. */
  limits?: TradingLimitsSnapshot | null;
  /** The tool's error text, when the read failed. */
  limitsError?: string | null;
  /** The coded refusal being explained. */
  refusal?: { code: string; verdict?: TradingLimitVerdict | null } | null;
  /** A cancel receipt for "what did you stop". */
  cancelReceipt?: CancelReceiptSummary | null;
}

export interface LimitAnswer {
  answer: string;
  /** Which keys the answer quoted — empty when the read failed. */
  usedLimitKeys: TradingLimitKey[];
  source: "tool_output" | "read_failed" | "no_receipt";
}

const SOURCE_LABEL: Record<string, string> = {
  "ticker-override": "ticker override",
  setting: "setting",
  env: "env",
  unset: "unset",
};

function sourceText(field: { source: string; readFrom: string | null }): string {
  const label = SOURCE_LABEL[field.source] ?? field.source;
  return field.readFrom ? `${label} (${field.readFrom})` : label;
}

function fieldLine(snapshot: TradingLimitsSnapshot, key: TradingLimitKey): string {
  const field = snapshot.limits[key];
  if (!field || field.value === null) {
    return `${key}: not configured (${tradingLimitEnvVar(key)} unset)`;
  }
  return `${key}: ${formatTradingLimitAmount(key, field.value)} — ${sourceText(field)}`;
}

/**
 * Build the answer. Deterministic and pure: the same payload always produces
 * the same words, so a golden-question fixture can pin it.
 */
export function answerTradingLimitQuestion(input: LimitAnswerInput): LimitAnswer {
  if (input.question === "what_did_you_stop") {
    const receipt = input.cancelReceipt;
    if (!receipt) {
      return {
        answer:
          "I have no cancel receipt to report, so I cannot say what was stopped. A cancel returns a receipt listing every order it targeted; ask me to cancel and I will quote that receipt.",
        usedLimitKeys: [],
        source: "no_receipt",
      };
    }
    const cancelled = receipt.cancelled ?? [];
    const refused = receipt.refused ?? [];
    const lines = [
      receipt.message ??
        `${receipt.action ?? "Cancel"}: targeted ${receipt.targeted ?? cancelled.length + refused.length}, cancelled ${cancelled.length}, refused ${refused.length}.`,
    ];
    if (cancelled.length > 0) {
      lines.push(`Stopped: ${cancelled.map((entry) => `${entry.orderId}${entry.symbol ? ` (${entry.symbol})` : ""}`).join(", ")}.`);
    }
    if (refused.length > 0) {
      lines.push(`Still live: ${refused.map((entry) => `${entry.orderId} — ${entry.message}`).join("; ")}.`);
    }
    return { answer: lines.join(" "), usedLimitKeys: [], source: "tool_output" };
  }

  const snapshot = input.limits ?? null;
  if (!snapshot) {
    return {
      answer:
        `I could not read your trading limits, so I will not guess them. The configuration read failed` +
        `${input.limitsError ? ` (${input.limitsError})` : ""}. ` +
        `They live in the trading:limits setting (per-ticker overrides in trading:limits:<SYMBOL>) or the TRADING_LIMIT_* env vars; ` +
        `fix the read and ask again.`,
      usedLimitKeys: [],
      source: "read_failed",
    };
  }

  const scope = snapshot.symbol ? ` for ${snapshot.symbol}` : "";

  if (input.question === "what_are_my_limits") {
    const lines = [
      `Your effective trading limits${scope}, read from configuration at ${snapshot.readAt}:`,
      ...TRADING_LIMIT_KEYS.map((key) => fieldLine(snapshot, key)),
      `session window: ${snapshot.sessionWindow.startMinuteEt}–${snapshot.sessionWindow.endMinuteEt} minutes ET ` +
        `(${snapshot.sessionWindow.extendedHours ? "extended hours allowed" : "regular session only"}) — ${sourceText(snapshot.sessionWindow)}`,
    ];
    return { answer: lines.join("\n"), usedLimitKeys: [...TRADING_LIMIT_KEYS], source: "tool_output" };
  }

  if (input.question === "budget_left") {
    const field = snapshot.limits.maxNotionalPerTicker;
    if (!field || field.value === null) {
      return {
        answer:
          `maxNotionalPerTicker is not configured${scope}, so there is no budget to report — and none is assumed. ` +
          `Set it in trading:limits or ${tradingLimitEnvVar("maxNotionalPerTicker")}.`,
        usedLimitKeys: ["maxNotionalPerTicker"],
        source: "tool_output",
      };
    }
    const used = input.refusal?.verdict?.used ?? null;
    const budget = formatTradingLimitAmount("maxNotionalPerTicker", field.value);
    if (used === null || used === undefined) {
      return {
        answer:
          `maxNotionalPerTicker${scope} is ${budget} — ${sourceText(field)}. ` +
          `No usage figure came back with the limits read, so I cannot state what is left; ask me after a refusal or a ladder receipt, which carry the used amount.`,
        usedLimitKeys: ["maxNotionalPerTicker"],
        source: "tool_output",
      };
    }
    const remaining = Math.max(0, field.value - used);
    return {
      answer:
        `maxNotionalPerTicker${scope} is ${budget} — ${sourceText(field)}; ` +
        `used ${formatTradingLimitAmount("maxNotionalPerTicker", used)}, remaining ${formatTradingLimitAmount("maxNotionalPerTicker", remaining)}.`,
      usedLimitKeys: ["maxNotionalPerTicker"],
      source: "tool_output",
    };
  }

  // why_refused
  const verdict = input.refusal?.verdict ?? null;
  const code = input.refusal?.code ?? verdict?.code ?? null;
  if (!code) {
    return {
      answer:
        "No coded refusal was returned with that action, so I cannot name a limit. I will not invent one; re-run the action and I will quote the refusal it returns.",
      usedLimitKeys: [],
      source: "tool_output",
    };
  }
  if (!verdict || !verdict.limit) {
    return {
      answer:
        `The action was refused with \`${code}\`, but the refusal carried no limit detail, so I cannot state which cap produced it. ` +
        `The configured limits${scope} are:\n${TRADING_LIMIT_KEYS.map((key) => fieldLine(snapshot, key)).join("\n")}`,
      usedLimitKeys: [...TRADING_LIMIT_KEYS],
      source: "tool_output",
    };
  }
  return {
    answer:
      `That was refused: ${describeTradingLimitRefusal(verdict, code)}. ` +
      `The limit is ${sourceText(snapshot.limits[verdict.limit])}.`,
    usedLimitKeys: [verdict.limit],
    source: "tool_output",
  };
}
