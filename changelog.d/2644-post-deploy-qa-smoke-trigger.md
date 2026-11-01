### Fixed

- **Post-deploy QA and tag-release trigger condition (#2644):** updated `qa-smoke` and `tag-release` job conditions in `.github/workflows/deploy.yml` to support `workflow_run` events (from green CI completions on `main`) alongside `workflow_dispatch` and `push`, resolving the dead gate where post-deploy QA and release tagging were skipped on all deploys following #2556.

## Agent #CISO-bhdm

Closes #2644

Process documentation impact: None.
