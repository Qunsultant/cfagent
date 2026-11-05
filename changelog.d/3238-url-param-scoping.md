### Fixed
- Every menu/sub-menu tab now shows a URL carrying only its own params: navigating to a different tab drops the previous page's query params (`?tab=order&orderTab=risk` to portfolio lands on exactly `?tab=portfolio`), via a param-ownership registry in the router. Autopilot gains a deep-link entry for its clean canonical `?tab=autopilot`.
