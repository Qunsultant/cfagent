### Changed

- **GitOps: default PR template points at the docs/hotfix variants (#4091)**: `.github/pull_request_template.md` now names both variants in `.github/PULL_REQUEST_TEMPLATE/` (`docs.md`, `hotfix.md`) and the `?template=` mechanism for selecting them, and gitops.md §9 states the variants — GitHub shows no chooser for PR templates, so the default template is the only place an agent learns the variants exist. Qunsultant/cfagent#4091
