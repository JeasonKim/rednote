---
name: wf-mr3byfwob5fe373e
description: Run the bundled 小红书创作 workflow, advance ready DAG nodes, report node results, and show its branded native task dashboard beside the conversation.
---

# 小红书创作

This plugin runs without Skill Flow login or credit charging.

## Native dashboard contract

1. On the first use of this plugin in a conversation, call `render_workflow_dashboard_widget` once before starting the task.
2. Call `render_workflow_dashboard_widget` again only when the user explicitly asks to open or restore the dashboard.
3. Do not render the widget again on every turn while it is already visible. The widget polls task state automatically.
4. The native widget is the only dashboard surface.

## Run contract

1. Call `create_task` once for each new user task. In commissioned plugins, this call charges the configured Skill Flow task fee.
2. Call `start_task` and execute every returned ready node. When multiple nodes are ready, use sub-agents in parallel.
3. Read each node's Context paths and follow its mission and verification contract.
4. Call `complete_node` after verifying a node. Repeat `start_task` until the task completes.
5. Use the returned `executionToken` as `x-skillflow-creator-execution-token` for bundled Skill Flow official-service calls.
