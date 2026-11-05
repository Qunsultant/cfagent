### Fixed

- fix(3197): E*TRADE connect keeps a usable tab handle — `noopener` makes `window.open` return null, which stranded the authorization tab on about:blank and made the failure reclaim dead code; the opener is now severed explicitly and the wait shows a connecting placeholder
