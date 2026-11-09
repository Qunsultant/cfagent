### Fixed

Settings defaults are Alpaca + paper: the environment default is TEST (paper) when no selection is persisted — server resolver, client in-memory default, and the read routes that share the one selection all resolve paper for a fresh tenant, and live is an explicit stored selection (#3857). The broker default was already Alpaca end to end (#3812); this change also corrects the two stale comments that said otherwise.
