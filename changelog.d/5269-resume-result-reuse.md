### Fixed

- Paused + resumed goal shards reuse the options leg's journaled result instead of storing a result-less row (#5269, sub-issue of #4860): the ledger wrapper now short-circuits only on terminal records and adopts active ones through the ledger's legal transitions, and the host dispatch reads the leg job's residency record back first — a settled run's screen artifact is returned without a second workflow instance. A resumed sync leg re-executes (named; its stores hold no settlement proof), and the canonical store refuses a result-less envelope by name.
