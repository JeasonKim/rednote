---
name: wf-mr3byfwob5fe373e
description: Run the bundled 老徐rednote workflow, advance ready DAG nodes, report node results, and show its branded native task dashboard beside the conversation.
---

# 老徐rednote

This plugin runs without Skill Flow login, task execution fees, or creator usage commission. Official Skill Flow services may still consume the user's credits normally.

## Native dashboard contract

1. On the first use of this plugin in a conversation, call `render_workflow_dashboard_widget` once before starting the task.
2. Call `render_workflow_dashboard_widget` again only when the user explicitly asks to open or restore the dashboard.
3. Do not render the widget again on every turn while it is already visible. The widget polls task state automatically.
4. The native widget is the only dashboard surface.

## Run contract

1. Call `create_task` once for each new user task.
2. Call `start_task` and execute every returned ready node. When multiple nodes are ready, use sub-agents in parallel.
3. Read each node's Context paths and follow its mission and verification contract.
4. Call `complete_node` after verifying a node. Repeat `start_task` until the task completes.
