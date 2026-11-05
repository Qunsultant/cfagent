/**
 * Issue #3292: bridge the Alpaca credential names the deploy writes into the
 * names this codebase reads.
 *
 * `.github/workflows/deploy.yml` sets `ALPACA_PAPER_API_KEY`,
 * `ALPACA_PAPER_SECRET_KEY`, `ALPACA_PAPER_URL`, the `ALPACA_LIVE_*` trio and
 * `ALPACA_MARKET_URL` on the Worker — and says, in its own comment, that no code
 * reads those names. The adapter, meanwhile, reads `ALPACA_API_KEY`,
 * `ALPACA_SECRET_KEY` and `ALPACA_BASE_URL`. So a deployed Worker looked
 * unconfigured and Alpaca appeared to be missing from the build.
 *
 * `withAlpacaCredentials` decides the side once (deployment pin → persisted
 * selection → legacy base-URL inference, the same precedence as #3280) and maps
 * only that side's pair onto the generic names. A generic value already present
 * always wins, and the input env is never mutated.
 */
import type { Env } from "../../types";

export type AlpacaSide = "paper" | "live";

/** Which trading side this env/selection is on. */
export function alpacaTradingSide(env: Env, overrideEnv?: string): AlpacaSide {
  const pin = String(env.ALPACA_TRADING_TYPE ?? "").trim().toLowerCase();
  if (pin === "paper" || pin === "live") return pin;

  const selection = String(overrideEnv ?? "").trim().toUpperCase();
  if (selection === "TEST") return "paper";
  if (selection === "PROD") return "live";

  const base = env.ALPACA_BASE_URL;
  return base && !base.includes("paper-api") ? "live" : "paper";
}

/** Map the deployed pair for this env's side onto the generic names. */
export function withAlpacaCredentials(env: Env, overrideEnv?: string): Env {
  const side = alpacaTradingSide(env, overrideEnv);
  const isLive = side === "live";

  const key = isLive ? env.ALPACA_LIVE_API_KEY : env.ALPACA_PAPER_API_KEY;
  const secret = isLive ? env.ALPACA_LIVE_SECRET_KEY : env.ALPACA_PAPER_SECRET_KEY;
  const url = isLive ? env.ALPACA_LIVE_URL : env.ALPACA_PAPER_URL;

  if (!key && !secret && !url) return env;

  return {
    ...env,
    ALPACA_API_KEY: env.ALPACA_API_KEY || key,
    ALPACA_SECRET_KEY: env.ALPACA_SECRET_KEY || secret,
    ALPACA_BASE_URL: env.ALPACA_BASE_URL || url,
  } as Env;
}
