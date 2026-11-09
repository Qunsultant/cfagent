### Fixed

- **Portfolio hero no longer calls a paper account “LIVE” (#3880):** the badge and the live/paper copy came from local `activeEnv` (`activeEnv === "PROD"`) while the server resolves the side from the persisted selection. They now follow the `environment` each broker read echoes, with local state only as the pre-read fallback. #rsi
- **“Active Positions” shows unknown until the first read lands (#3880):** `portfolioSummary` exposes `reported`, so the hero prints an em dash with “Not read yet … use ↻ Refresh Positions” instead of claiming `0` for an account it has not read. #rsi
