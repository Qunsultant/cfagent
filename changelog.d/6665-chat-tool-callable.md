### Scheduling

- Chat turns can now call the agent schedule tool as `tool_openaimp_manage_agent_schedule` (aliased to `manage_agent_schedule`), and its schema states the create constraints up front — valid kinds, executionMode required for create, schedulable-only callback/operation, goal budgetCents greater than 0, nested goal object — so a complete create parses in one round instead of failing once per hidden constraint (#6665).
