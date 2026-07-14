---
name: skillflow-xiaohongshu
description: Run the bundled 小红书单篇笔记生产流 workflow, advance ready DAG nodes, report node results, and keep its branded task dashboard visible beside the conversation.
---

# 小红书单篇笔记生产流

This plugin runs without Skill Flow login or credit charging. Open the dashboard before calling `create_task`.

## Persistent dashboard contract

1. At the beginning of every user turn that invokes this plugin, call `open_workflow_dashboard`. The call is idempotent and returns the current `http://127.0.0.1:<port>/` URL.
2. Immediately invoke `browser:control-in-app-browser` and select the Codex in-app Browser. Keep exactly one dedicated dashboard tab at the returned URL: reuse it when present, navigate it when the URL changed, and recreate it when missing.
3. Keep the Browser sidebar visible while the task runs. The page polls task state automatically, so node progress and outputs appear beside the conversation without reopening the page.
4. Never close the dashboard tab when a task, turn, or final response completes. The user explicitly wants this persistent conversation-plus-dashboard workspace.
5. Never use an operating-system browser, Computer Use, or an MCP App Widget to show this dashboard.

## Run contract

1. Call `create_task` once for each new user task.
2. Call `start_task` and execute every returned ready node. When multiple nodes are ready, use sub-agents in parallel.
3. Read each node's Context paths and follow its mission and verification contract.
4. Call `complete_node` after verifying a node. Repeat `start_task` until the task completes.
5. Use the returned `executionToken` as `x-skillflow-creator-execution-token` for bundled Skill Flow official-service calls.
