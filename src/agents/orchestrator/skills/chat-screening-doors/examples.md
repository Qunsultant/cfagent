# Worked examples — chat screening doors

## 1. Options strategy screen (direct return)

User: "Screen for bull put credit spreads in the NASDAQ100 with
max loss <= $30 and my max profit greater than $0."

Door: run_options_strategy_screen.
Parameters: strategyType 'Bull Put Credit Spread' (a catalog
label; resolves to the put credit spread), universe NASDAQ100,
maxLoss 30, minProfit 0.
Outcome: the scan runs inline and returns the matching
opportunities, or an honest no_opportunities result if none match.
Never deflect this request to a UI workflow.

## 2. Stock screen (job carriage)

User: "Run a stock screen over the NASDAQ100."

Door: run_stock_screen.
Parameters: universe NASDAQ100 (also the default when the user
names no universe).
Outcome: a ScreenerScreenWorkflow run starts under a
'screener:chat:...' job id; the door awaits it and returns the
run's outcome from the canonical read-back — not a result invented
at start time.

## 3. 'ALL' on the strategy door (refused)

User: "Scan ALL universes for iron condors."

Door behavior: run_options_strategy_screen refuses 'ALL' with
door_unavailable — a single inline scan cannot fan out over a
sharded universe set. Ask which concrete universe to scan, or, if
a listings-style scan over ALL is what the user wants, that is
the market scan tool, not this door.

## 4. Non-deterministic mode while disabled (refused)

User: "Screen stocks, interpreting what I mean in AI mode."

Door behavior: if the deployment has the non-deterministic
screener mode off, run_stock_screen refuses with
nd_mode_unavailable. Do not downgrade silently: tell the user the
mode is unavailable in this deployment and offer a deterministic
run only as their choice.

## 5. Unknown strategy (refused before any engine call)

User: "Find me some moonshot butterfly ladders."

Door behavior: if the named strategy does not resolve against
the engine's catalog, run_options_strategy_screen refuses with
invalid_strategy_type. Offer the catalog strategies the engine
actually has (by id, label, or alias); never invent a strategy.
