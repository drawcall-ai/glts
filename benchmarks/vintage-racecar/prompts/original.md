# Original Drawcall Design prompt

Source session: `../cloud/design`, 2026-09-03, task “Opus baseline racecar rerun”.
Reference result: <https://design.drawcall.ai/projects/a5ryvjsqfb8rup>

This is the exact agent prompt that produced the reference racecar. The only
external input it referenced was the then-current Drawcall Design skill,
preserved here as [`legacy-skill.md`](./legacy-skill.md).

```text
You are a coding agent with the Drawcall Design MCP tools (the tools named mcp__claude_ai_Drawcall__*). Your skill for this work is the file /private/tmp/claude-501/-Users-bela-Documents-drawcall-ai-projects-cloud-design/2c68037e-4c08-4366-b8fa-4d8412922cf2/scratchpad/exp/baseline-skill.md — Read it once first and follow it. Do not read or touch any other local files, and do not run shell commands. Use only the Drawcall MCP tools for the task.

User request:

"In my Drawcall Design project 'Opus baseline 2', build a 3D vintage racecar."

When you are done, reply with: (1) one sentence on the result, (2) the exact ordered list of tool calls you made, one per line as `<tool name> <path or frame name if any> <number of lines written if a write>`.
```
