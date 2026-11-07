# Screener Rules & Quantitative Options Architecture

**Document Version:** 1.0.0
**Target File:** `docs/architecture/business/screener-rules.md`
**Reference Specification:** [openaimp/amuse: docs/architecture/business/amuse-logic.md](https://github.com/OpenAIMP/amuse/blob/main/docs/architecture/business/amuse-logic.md)
**Repository:** `OpenAIMP/cfagent`
**Scope:** Quantitative Options & Stock Screening Business Rules, Decision Pipeline, Formulas, Strategies, and System Alignment

---

## Executive Summary & Operating Discipline

This document formalizes the stock and options screening business rules and quantitative logic for the platform. It builds upon and incorporates the reference architecture defined in [`amuse-logic.md`](https://github.com/OpenAIMP/amuse/blob/main/docs/architecture/business/amuse-logic.md).

The screening system adheres to a strict quantitative operating philosophy:

> **"No indicator places a trade. Every signal answers exactly one question, and a trade only happens when they all agree."**

### The 6-Stage Decision Pipeline

```
[ Screen ] ──> [ Regime ] ──> [ Timing ] ──> [ Strikes ] ──> [ Size ] ──> [ Preflight ]
 (Find)         (Strategy)     (Entry)       (Structure)    (Risk)        (Execute)
```

1. **Screen**: Filter universe for liquidity, price bounds, volume thresholds, and volatility baselines.
2. **Regime**: Identify underlying market regime: Bullish (`UP`), Bearish (`DN`), or Neutral/Ranging (`RNG`) to map valid strategy families.
3. **Timing**: Assess entry suitability (RSI, %B, Squeeze, Gap) to prevent chasing extended moves.
4. **Strikes**: Determine precise leg placement based on target deltas ($0.10 - 0.20\Delta$ short credit spreads, $0.15 - 0.35\Delta$ short calls in PMCC) and technical pivots/Fibonacci retracements.
5. **Size**: Scale position size according to account risk limits (max loss $\le 2\%$ per position, total open heat $\le 35\%$, max loss gates per structure).
6. **Preflight**: Verify binary event gates (earnings, dividend dates), broker session validity, and human approval posture (draft-only execution).

---

## 1. Inventory of Screening Criteria, Rules & Formulas

### 1.1 Technical & Stock Screener Rules

Evaluates equity price action over daily bar histories (minimum 200 bars) using technical indicators and composite scoring.

#### Technical Formulas
- **Relative Strength Index (RSI 14)**:
  $$\text{RSI} = 100 - \frac{100}{1 + \frac{\text{EMA}(\text{Gain}, 14)}{\text{EMA}(\text{Loss}, 14)}}$$
  - *Readings*: $< 30$ Oversold, $> 70$ Overbought, $30 - 70$ Neutral.

- **Bollinger Bands (20, 2.0)**:
  $$\text{Middle} = \text{SMA}(P, 20), \quad \text{Upper/Lower} = \text{Middle} \pm 2.0 \times \sigma_{20}$$
  $$\%B = \frac{P - \text{Lower}}{\text{Upper} - \text{Lower}}$$
  - *Extension Gate*: $\%B \in [0.0, 1.0]$. $\%B > 1.0$ flags overextended price ("don't chase").
  - *Squeeze Gate*: Bandwidth ($\frac{\text{Upper} - \text{Lower}}{\text{Middle}}$) at $N$-day minimum ($N=125$).

- **Anchored VWAP (52-Week Low)**:
  $$\text{AVWAP} = \frac{\sum (P_i \times V_i)}{\sum V_i} \quad \text{anchored from 52-week low bar}$$
  - *Gate*: Spot price must remain above Anchored VWAP (`require_above_anchored_vwap: true`).

- **Moving Average Structure & Crosses**:
  - Requires $\text{SMA}_{50} > \text{SMA}_{200}$ for bullish trend alignment.
  - Death Cross ($\text{SMA}_{50} < \text{SMA}_{200}$) within 20 sessions triggers hard rejection for long equity / bullish spreads.

- **Fractal Pivots ($n=5$) & Fibonacci Retracements**:
  - Identified High/Low pivots require $P_t$ to be extreme compared to $n$ preceding and trailing bars.
  - Key Fib levels computed at $38.2\%, 50.0\%, 61.8\%$ over the 6-month swing range.

- **HH/HL Trend Structure & Regime Classification**:
  - **`UP`** (Uptrend): Higher Highs + Higher Lows.
  - **`DN`** (Downtrend): Lower Highs + Lower Lows (hard rejection for bullish selling).
  - **`RNG`** (Range/Neutral): Mixed pivot structure.

#### 6-Vote Composite Bias Score
Calculates 6 binary votes (1 point each):
1. $P > \text{SMA}_{50}$
2. $P > \text{SMA}_{200}$
3. $\text{SMA}_{50} > \text{SMA}_{200}$
4. $\text{MACD line} > 0$
5. $\text{RSI}_{14} > 50$
6. Pivot structure is `UP`
- **Bias Assessment**: $\ge 4$ Bullish, $\le 2$ Bearish, 3 Neutral.

---

### 1.2 Options Spread & Multi-Leg Screener Rules

Evaluates multi-leg options structures across 21–60 DTE with conservative net fill estimation (**short leg bid $-$ long leg ask**).

#### Auto Width Scaling Formula
Spread strike width auto-scales based on underlying spot price $S$:
$$\text{Width} = \min\left(5.0, \max\left(1.0, \text{round}\left(\frac{S}{25}\right)\right)\right)$$

#### Expected Value (EV) & Win% Model
$$\text{Win\%}_{\text{est}} = 1.0 - |\Delta_{\text{short}}|$$
$$\text{EV} = P(\text{Win}) \times \text{Credit}_{\text{net}} - P(\text{Loss}) \times \text{MaxLoss} - \text{Friction}$$
$$\text{Friction} = \frac{\sum (\text{Ask}_i - \text{Bid}_i)}{\text{Credit}_{\text{net}}} \quad (\text{Gate}: \text{Friction} \le 3.0)$$

#### Strategy Classification Taxonomy (34 Strategies)

| Strategy Family | Strategy Name | Leg Rules & Selection Criteria | Target Market Regime |
|---|---|---|---|
| **Defined-Risk Core** | Bull Put Spread | Short Put $0.10 - 0.20\Delta$, Long Put 1 width lower | Bullish / `UP` |
| | Bear Call Spread | Short Call $0.10 - 0.20\Delta$, Long Call 1 width higher | Bearish / `DN` |
| | Iron Condor | Bull Put Spread + Bear Call Spread | Neutral / `RNG` |
| | Asymmetric Condor | Bull Put Spread + Call wing $\ge 8\%$ OTM | Bullish tilt |
| | Iron Butterfly | ATM Short Call + Short Put, OTM Long Wings | Low Vol / Range |
| | Credit Calendar Spread | Sell Near DTE / Buy Far DTE at same strike | Vol expansion / Range |
| | Long Butterfly | Buy 1 Low, Sell 2 ATM, Buy 1 High | Price target / Pin |
| | Covered Call | Long 100 shares + Short Call $0.15 - 0.35\Delta$ | Mildly Bullish |
| | Cash-Secured Put | Short Put $0.10 - 0.20\Delta$ collateralized | Neutral to Bullish |
| | Jade Lizard | Bull Put Spread + Far-OTM Short Call ($\ge 8\%$ OTM) | Bullish / No upside risk |
| | Reverse Jade Lizard | Bear Call Spread + Far-OTM Short Put | Bearish / No downside risk |
| **Exotics & Ratio Spreads** | Call Backspread | Sell 1 ITM/ATM Call, Buy 2 OTM Calls | Aggressive Bullish / Vol Breakout |
| | Put Backspread | Sell 1 ITM/ATM Put, Buy 2 OTM Puts | Aggressive Bearish / Crash |
| | Ratio Call Spread | Buy 1 OTM Call, Sell 2 Far-OTM Calls | Mild Bullish with Cap |
| | Ratio Put Spread | Buy 1 OTM Put, Sell 2 Far-OTM Puts | Mild Bearish with Cap |
| | Broken-Wing Butterfly | Asymmetric wing widths (+1 / -2 / +1) | Directional / Zero upside risk |
| | Call / Put Ladders | 3-leg combinations (+1 / -1 / -1) | High conviction directional |
| | Synthetic Futures | Long ATM Call + Short ATM Put (or vice versa) | Full Delta Directional |
| | Risk Reversal | Short OTM Put + Long OTM Call | Directional Leverage |
| | Straddle / Strangle | Long or Short ATM/OTM Call + Put pairs | Volatility Expansion / Contraction |
| | Guts Spread | ITM Call + ITM Put | Deep Premium Capture |
| | Double Diagonal | Diagonal Call + Diagonal Put | Multi-expiry Range |

---

### 1.3 Poor Man's Covered Call (PMCC) Rules

Structures LEAPS Call x Short Call pairs as capital-efficient covered call alternatives.

#### Selection Rules & Gates
- **LEAPS Long Call**: DTE 270–800, Delta $0.80 - 0.95$, Open Interest / Volume $\ge 25$.
- **Near-term Short Call**: DTE 21–60, Delta $0.15 - 0.35$, Open Interest / Volume $\ge 10$.
- **Capital Gate**: Maximum net debit per pair $\le \$10,000$.
- **Friction Gate**:
  $$\frac{\text{Spread}_{\text{long}} + \text{Spread}_{\text{short}}}{\text{Bid}_{\text{short}}} \le 3.0$$
- **Breach Distance Gate**: Short strike must be $\ge 8\%$ above spot price or LEAPS breakeven ($K_{\text{LEAPS}} + \text{Debit}$).
- **30-Day Premium-to-Debit Yield Metric**:
  $$\text{Yield}_{30d} = \frac{\text{Credit}_{\text{short}}}{\text{Debit}_{\text{LEAPS}}} \times \left(\frac{30}{\text{DTE}_{\text{short}}}\right) \ge 4.0\%$$

---

### 1.4 Pre-Market & Intraday Screener Rules

#### Pre-Market Momentum
- **Gap Gate**:
  $$|\text{Gap}\%| = \left|\frac{P_{\text{pre}} - P_{\text{close, prev}}}{P_{\text{close, prev}}}\right| \ge 2.0\%$$
- **Relative Volume (RVOL)**: Time-bucket prorated volume comparison vs 20-day average ($\ge 1.5\times$).
- **ATR% Gate**: $\text{ATR}\% \in [1.0\%, 8.0\%]$.

#### Intraday Opening-Range Breakouts (ORB)
- **15-Minute Opening Range**: Tracks High ($OR_H$) and Low ($OR_L$) from 09:30–09:45 ET.
- **Breakout Trigger**: Spot price clears $OR_H \times (1 + 0.001)$ with time-prorated $\text{RVOL} \ge 1.5\times$.
- **VWAP Confirmation**: Price holding above Session VWAP for $\ge 70\%$ of completed 15-minute bars.

---

### 1.5 Volatility Framework Rules

Evaluates Implied Volatility (IV) vs Realized/Historical Volatility (HV) and term structure before approving short-premium strategies.

#### Formulas
- **Historical Volatility (HV 20/60)**:
  $$\text{HV} = \sqrt{252} \times \sigma\left(\ln \frac{P_t}{P_{t-1}}\right)$$
- **IV Rank (IVR)**:
  $$\text{IVR} = 100 \times \frac{\text{IV}_{\text{current}} - \text{IV}_{\min, 52w}}{\text{IV}_{\max, 52w} - \text{IV}_{\min, 52w}}$$
- **25-Delta Skew**:
  $$\text{Skew}_{25} = \text{IV}_{\text{Put}, 25\Delta} - \text{IV}_{\text{Call}, 25\Delta}$$

#### Decision Matrix
- $\text{IVR} > 50$ **and** $\text{IV} > \text{HV}$ $\rightarrow$ **`SELL_PREMIUM`** (Options overpriced; seller edge).
- $\text{IVR} < 25$ $\rightarrow$ **`STAND_DOWN`** (Options cheap; veto short-premium trades).
- Otherwise $\rightarrow$ **`NO_READ`** (Default to technical and options strike gates).

---

### 1.6 Risk Management, Position Sizing & Exits

#### Position Exit Rules
- **Profit Target**: Take profit when $50\%$ of max credit captured.
- **Stop Loss**: Close when buy-to-close debit reaches $2.0\times$ net credit received.
- **Time Exit**: Mandatory exit or roll at $7 \text{ DTE}$.
- **Assignment Guard**: Close position at $\le 2 \text{ DTE}$ if ITM; no physical assignment permitted.

#### Portfolio Sizing & Heat Caps
- **Trade Risk Limit**: Maximum risk per position $\le 2\%$ of net liquidation value.
- **Total Open Heat**: Total open max loss across all positions $\le 35\%$ of account equity.
- **Fractional Kelly Formula**:
  $$f^* = \frac{p \cdot b - (1 - p)}{b} \times \text{Fraction} \quad \left(p = \text{Win\%}, b = \frac{\text{Credit}}{\text{MaxLoss}}\right)$$
  Unlocks sizing after $\ge 30$ historical verified trades.

---

## 2. Alignment with `cfagent` Architecture

The rules specified in this document align directly with `cfagent`'s trading and options architecture:

| `amuse` Screening Concept | `cfagent` Source Component | Implementation Role |
|---|---|---|
| Technical Screener & Indicators | `src/trading/screener.ts`, `src/trading/technicals.ts`, `src/trading/screeningIndicators.ts` | Equity scanning, TA computation (RSI, MA cross, pivots) |
| Options Spread Screener | `src/trading/optionsScreener.ts`, `src/trading/options/` | Chain retrieval, spread pricing, friction checks |
| Strategy Registry & Composition | `src/trading/registry.ts`, `src/trading/setupCatalog.ts` | Strategy definitions, multi-leg structure algebra |
| Screening Provider Abstraction | `src/trading/screeningProvider.ts`, `src/trading/screenerPipeline.ts` | Unified multi-broker screening over the routed providers |
| Recommendation Bundles & Risk | `src/trading/options/bundleEngine.ts`, `src/trading/quotePolicies.ts` | Decision-grade recommendation bundles, risk gates |
| Autopilot Policy Guardrails | `src/agentic/autopilot/` | Bounded execution rules, preflight checks, audit logging |

---

## 3. Cross-Repository Reference Note

For additional architectural context, mathematical background, and gap analysis regarding the Options Lab screening engine, consult the primary source reference:
- **URL:** [https://github.com/OpenAIMP/amuse/blob/main/docs/architecture/business/amuse-logic.md](https://github.com/OpenAIMP/amuse/blob/main/docs/architecture/business/amuse-logic.md)

---
*End of Screener Rules & Quantitative Options Architecture.*
