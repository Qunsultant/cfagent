### Fixed

- **Auto-merge label job no longer mints bogus lane labels from comment URLs (#4826):** the "Label the PR" step grepped the whole PR body for the first hashtag-like token, so a comment URL above the `## Agent` section (`…#issuecomment-6912862129`) minted `lane:issuecomment-6912862129` instead of the real lane. The lane is now read only from the `## Agent` section; a body with no `## Agent` section gets no lane label. #CISO-bhdm
