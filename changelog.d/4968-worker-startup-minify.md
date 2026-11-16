### Minify the Worker bundle to fix deploy error 10021 (#4968)

Deploy NextGenTP failed with Cloudflare error 10021 (Worker startup exceeded the 1s CPU limit).
Minifying the bundle cuts it from 24,942,845 to 13,228,323 bytes and parse time from 456ms to
369ms median, giving the deploy headroom under the 1s startup limit. No behavior change.
