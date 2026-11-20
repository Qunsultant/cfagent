### Added

- **Pin: every OODA stage runs its own step (#5913):** the job catalogue declares `step: noop` for feed / enrich / generate / deliver, and the definition builder rewrites each child to `research.feed`, `research.enrich`, `analyze.ooda`, `research.generate`, `research.deliver`, `evaluate.apply`. Only the children's *kinds* were pinned, so a regression in that rewrite would have turned four stages into silent no-ops while a run still reported "6/6 stages". The pin asserts the six kinds, the six step bindings, and that the container's own step stays `noop`. #ceo-aimp
