<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Model routing

- **Planning / research / exploration agents** → use `model: "opus"`
- **Implementation / code-writing agents** → use `model: "sonnet"`

This applies to all Agent tool calls. Opus for thinking, Sonnet for building.
