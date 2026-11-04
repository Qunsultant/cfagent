### Added

- Signed-out deep links now return to the bookmarked page after
  sign-in (#3015): the target (path + query, hash where present)
  travels through the signed OAuth state, survives a provider
  switch, and is validated same-origin + in-app-route-only at
  every use — external or tampered targets fall back to the
  default landing, never off-site. Direct sign-in with no target
  keeps today's default landing.
