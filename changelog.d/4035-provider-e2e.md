### Added

- **The Public.com provider's end-to-end path is pinned, not implied (#4035):** the env-factory test stored a personal access token and then read only a quote. It now reads **both** grounded capabilities through the same provider — quote, option expiries and an option chain — and asserts each result carries `providerId: "public"`, so "connect the token and the provider serves" is one test rather than an inference. The stricter chain rule from #4036 runs under it unchanged.
