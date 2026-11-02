### Added

- PMCC gates enforced for #1769 (parent #1717): friction <= 3.0, breach distance (short strike >= 8% above spot or >= LEAPS breakeven), and 30-day premium yield >= 4.0% now run as PMCC-only acceptance rules in DEFAULT_ACCEPTANCE_RULES, so the engine rejects failing PMCC candidates while passing every other strategy type through unchanged. Unevaluable PMCC legs fail closed.
