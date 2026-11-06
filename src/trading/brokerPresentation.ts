/**
 * Issue #3417 (epic #3416): how a broker is *named* on a surface.
 *
 * Why this module exists: the catalogue (`brokerCatalog.ts`) answers what a
 * broker can DO. It deliberately says nothing about what a broker is CALLED,
 * so every surface that needed a name invented one — and the invention was
 * almost always "E*TRADE", because that was the first broker. A name is not a
 * capability: an Alpaca tenant reading "E*TRADE Voice Trading Desk" is reading
 * a lie that no capability check would ever catch.
 *
 * So the vocabulary lives here, once, per broker:
 *   - the label the user selected,
 *   - the desk and speaker names the voice/omnichannel surfaces render,
 *   - the mode badge (the broker's words for paper/live),
 *   - the sentence describing a live session, because a session is a broker
 *     fact: E*TRADE's token expires at midnight Eastern; Alpaca's key pair
 *     does not expire at all. One sentence cannot be true for both.
 *
 * Rules this module keeps:
 *   - total over `BrokerId`, so a new broker cannot go unnamed (type error);
 *   - the fallback for an unrecognised id names NO broker — never E*TRADE,
 *     which would be the same defect with a different tenant;
 *   - pure data + one lookup. Nothing here reads the world at import, so both
 *     the worker and the client can import it.
 */
import { BROKER_CATALOG, isBrokerId, type BrokerId, type TradingType } from "./brokerCatalog";

export interface BrokerPresentation {
  /** False when the stored id is not a broker in the catalogue. */
  readonly known: boolean;
  /** The broker's own name, e.g. "E*TRADE". Never an environment. */
  readonly label: string;
  /** e.g. "Alpaca Voice Trading Desk". */
  readonly deskName: string;
  /** The transcript speaker, e.g. "Alpaca Voice Desk". */
  readonly deskAgentName: string;
  /** The chat surface's bot handle, e.g. "AlpacaAgent". */
  readonly botName: string;
  /**
   * The hero badge. It names the mode in the broker's own words: E*TRADE's
   * test environment is a sandbox, Alpaca's is paper trading.
   */
  readonly modeBadge: Readonly<Record<TradingType, string>>;
  /**
   * The mode as a lowercase phrase for inline copy ("Paper sandbox",
   * "Live execution"). E*TRADE calls its test environment a sandbox; Alpaca
   * calls the same thing paper trading, and borrowing the wrong noun is the
   * same defect as borrowing the wrong broker's name.
   */
  readonly modeWord: Readonly<Record<TradingType, string>>;
  /**
   * How a connected session is described. E*TRADE's OAuth token dies at
   * midnight Eastern; Alpaca's key pair has no expiry, so it must not borrow
   * that sentence.
   */
  readonly sessionCopy: Readonly<Record<TradingType, string>>;
}

/** The presentation for a broker the catalogue knows. */
const PRESENTATIONS: Readonly<Record<BrokerId, BrokerPresentation>> = {
  etrade: {
    known: true,
    label: "E*TRADE",
    deskName: "E*TRADE Voice Trading Desk",
    deskAgentName: "E*TRADE Voice Desk",
    botName: "ETradeAgent",
    modeBadge: { paper: "PAPER TRADING SANDBOX", live: "LIVE BROKERAGE" },
    modeWord: { paper: "Paper sandbox", live: "Live execution" },
    sessionCopy: {
      paper: "Access token active until midnight Eastern Time.",
      live: "Access token active until midnight Eastern Time.",
    },
  },
  alpaca: {
    known: true,
    label: "Alpaca",
    deskName: "Alpaca Voice Trading Desk",
    deskAgentName: "Alpaca Voice Desk",
    botName: "AlpacaAgent",
    modeBadge: { paper: "PAPER TRADING", live: "LIVE TRADING" },
    modeWord: { paper: "Paper trading", live: "Live trading" },
    sessionCopy: {
      paper: "API key pair verified for paper trading.",
      live: "API key pair verified for live trading.",
    },
  },
};

/**
 * The fallback for an id that is not a broker. It names no firm, because the
 * platform does not know which one the user meant — and guessing E*TRADE is
 * exactly the bug this module removes.
 */
const UNKNOWN_PRESENTATION: BrokerPresentation = {
  known: false,
  label: "Selected broker",
  deskName: "Voice Trading Desk",
  deskAgentName: "Voice Desk",
  botName: "TradingAgent",
  modeBadge: { paper: "PAPER TRADING", live: "LIVE TRADING" },
    modeWord: { paper: "Paper trading", live: "Live trading" },
  sessionCopy: { paper: "Session active.", live: "Session active." },
};

/** Presentation for a broker id — total, with a name-free fallback. */
export function brokerPresentation(broker: unknown): BrokerPresentation {
  if (isBrokerId(broker)) return PRESENTATIONS[broker];
  return UNKNOWN_PRESENTATION;
}

/**
 * The broker's name for a surface that must print one. Same fallback rule as
 * `brokerPresentation`: an unrecognised id is named as a selection, never as a
 * broker the platform did not resolve.
 */
export function brokerDisplayName(broker: unknown): string {
  return brokerPresentation(broker).label;
}

/**
 * The hero mode badge for a broker + trading type. Kept as its own function so
 * a surface cannot compose the two halves itself and reintroduce a mixed
 * vocabulary ("Alpaca · PAPER TRADING SANDBOX").
 */
export function brokerModeBadge(broker: unknown, tradingType: TradingType): string {
  return brokerPresentation(broker).modeBadge[tradingType];
}

/** True when every registered broker answers with its own name. */
export function brokerPresentationIsComplete(): boolean {
  return (Object.keys(BROKER_CATALOG) as BrokerId[]).every((broker) => {
    const presentation = PRESENTATIONS[broker];
    return Boolean(presentation) && presentation.known && presentation.label === BROKER_CATALOG[broker].label;
  });
}
