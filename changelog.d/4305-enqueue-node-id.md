### Fixed

- **The enqueue resolves the PR by the right field (#4305):** gh pr list --json exposes a pull request's node id as id, not 
odeId; asking for 
odeId fails the job outright, which the first live run after #4314 merged showed. The CI-completion enqueue now asks for id, and the pin fails if 
odeId returns. #autoclaw-001
