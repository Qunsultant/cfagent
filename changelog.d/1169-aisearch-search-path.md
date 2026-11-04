### Fixed
- Agent search now queries the configured Cloudflare AI Search instance's `/search` path, so successful searches return live instance results instead of silently answering from the built-in stub corpus when the bare endpoint call failed.
