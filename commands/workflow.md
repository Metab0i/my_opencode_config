---
description: Run a declarative workflow (JSON under ~/.config/opencode/workflow/)
agent: workflow
---

Run the named workflow on the following request:

$ARGUMENTS

If the request is empty, ask the user which workflow to run and what the input should be.

Run it exactly like this (substitute the two quoted arguments):

    node ~/.config/opencode/scripts/workflow-run.mjs --workflow WORKFLOW_NAME --request "$ARGUMENTS" --auto --stream

Where WORKFLOW_NAME is the workflow to run (e.g. `plan-critic`), or if the user named it
inline, use that name.

Then report the runner's stage markers and the final JSON summary back to the user.
