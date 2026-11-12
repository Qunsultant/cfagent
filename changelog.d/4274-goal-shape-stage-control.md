### Goal-shape stage control — decided-not-to (#4274)

The goal leg's job record is not addressable from a chat/MCP turn (decided-not-to, #4274): the goal leg runs over in-memory engine stores on the ScreenerAgent DO, so no durable job exists in the chat host's SQL, and binding the ports alone cannot fix it (a cross-DO control path is needed). The goal-shape refusal (`stage_port_unavailable`) now names the decision, and tests pin the refusal plus stop/cancel still reaching the engine.
