/**
 * Issue #3324 (programme #3292): OCC option symbols carry the contract detail
 * Alpaca's position payload omits.
 *
 * Alpaca reports an option position as an OCC symbol (e.g.
 * `AAPL260116C00150000`) plus quantity and cost basis — no strike, no expiry,
 * no call/put field. The risk model needs those three to find the contract in
 * the chain; without them every Alpaca option position is excluded from every
 * Greek total.
 *
 * The parse is read right-to-left because the OCC format is fixed-width at the
 * end and variable at the start:
 *
 *   root (1–6 alphanumerics, adjusted series may end in a digit)
 *   YYMMDD expiry (6 digits)
 *   C | P
 *   strike × 1000 (8 digits, zero-padded)
 *
 * Reading from the end is what makes an adjusted root like `AAPL1` parse
 * correctly: a left-to-right regex has to guess where the root stops, and
 * guessing is how a strike of $150 becomes a root of `AAPL2601`.
 *
 * A symbol that does not fit the format returns `null` — the caller then lists
 * the position as unresolved by name instead of inventing a contract.
 */

/** The contract detail an OCC symbol encodes. */
export interface OccContract {
  readonly root: string;
  /** ISO date (yyyy-mm-dd). Two-digit years are 20xx, the only range OCC lists. */
  readonly expirationDate: string;
  readonly optionType: "CALL" | "PUT";
  /** Dollars per share, e.g. 00150000 → 150. */
  readonly strikePrice: number;
}

const STRIKE_DIGITS = 8;
const DATE_DIGITS = 6;

export function parseOccSymbol(symbol: string): OccContract | null {
  const raw = String(symbol ?? "").trim().toUpperCase();
  if (!raw) return null;

  const strikeStart = raw.length - STRIKE_DIGITS;
  const typeIndex = strikeStart - 1;
  const dateStart = typeIndex - DATE_DIGITS;
  if (dateStart < 1) return null;

  const root = raw.slice(0, dateStart);
  if (!/^[A-Z0-9]{1,6}$/.test(root)) return null;

  const datePart = raw.slice(dateStart, typeIndex);
  if (!/^\d{6}$/.test(datePart)) return null;
  const year = 2000 + Number(datePart.slice(0, 2));
  const month = Number(datePart.slice(2, 4));
  const day = Number(datePart.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const typeChar = raw[typeIndex];
  if (typeChar !== "C" && typeChar !== "P") return null;

  const strikePart = raw.slice(strikeStart);
  if (!/^\d{8}$/.test(strikePart)) return null;
  const strikePrice = Number(strikePart) / 1000;
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) return null;

  return {
    root,
    expirationDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    optionType: typeChar === "C" ? "CALL" : "PUT",
    strikePrice,
  };
}
