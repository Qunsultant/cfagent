### Fixed

- **OODA Alpaca paper runs honor their selected mode (#3277):** through the existing PortThink research agent and durable `PortThinkWorkflow` J-stack path, an explicit Alpaca `paper` selection now resolves the paper host and credentials ahead of a deployment-wide live pin. The Alpaca adapter instance cannot fall back to live credentials when its paper pair is missing; the run stays paper and reports unavailable. Other broker paths and runs without an explicit Alpaca paper selection keep their existing mode behavior. #ceo-aimp
