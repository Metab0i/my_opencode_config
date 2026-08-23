---
name: research-workflow
description: Multi-source research workflow (verify sources -> extract facts -> synthesize report). Orchestration is agent-driven: the primary research agent routes work, and the extraction/synthesis instructions are inlined in the research-assistant and deep-research agents. This file documents the architecture and file contract.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: research-synthesis
---

# Research Workflow

This skill defines the multi-source research pipeline used by the Research agents. Orchestration lives in the primary `research` agent; the leaf agents carry their own inlined instructions:

- **Research Assistant** (`agent/research-assistant.md`) — inlines the extraction checklist, claim taxonomy, ledger schema, and output format.
- **Deep Research** (`agent/deep-research.md`) — inlines the claim-merge.py invocation, synthesis framework, report template, and response contract.

## Roles

| Agent | Mode | Responsibility |
|-------|------|----------------|
| Research (orchestrator) | primary, depth 0 | Route the query: `@sources` → fan out N × `@research-assistant` → `validate_ledger_paths` → `make_report_path` → `@deep-research` → relay the abstract |
| Research Assistant | subagent, leaf | Extract all relevant facts from ONE source into `~/tmp/ledger_<id>.json`; return a `LEDGER_PATH:` line |
| Deep Research (synthesizer) | subagent, leaf | Run claim-merge.py on the ledger paths, compile the report, return `ABSTRACT:` / `TOPIC_MATCH:` / `REPORT_PATH:` |

## Data flow & file contract

```
@sources            → source manifest (+ full_text_path ~/tmp/oa_<n>.txt where OA)
@research-assistant → ~/tmp/ledger_<id>.json (Write tool) + "LEDGER_PATH: ~/tmp/..." response line
@deep-research      → claim-merge.py → ~/research/<slug>.md (path from make_report_path) + ABSTRACT/TOPIC_MATCH/REPORT_PATH
```

- **OA full text**: `@sources` writes plain text to `~/tmp/oa_<n>.txt` and passes `full_text_path` to `@research-assistant` — this avoids funneling up to 50k-char blobs through subagent boundaries.
- **Claim ledgers**: each `@research-assistant` writes its own `~/tmp/ledger_<id>.json` and returns a path, so the orchestrator never parses JSON out of prose and `claim-merge.py` consumes files directly.
- **Ledger validation**: the `validate_ledger_paths` tool confirms each ledger exists, parses as JSON, and has a `source` object and a `facts` array, so failed extractions are caught deterministically.
- **Report filename**: the `make_report_path` tool computes `~/research/<slug>.md` deterministically from the query; the orchestrator passes that exact path to `@deep-research`, which writes there, verifies the file, and returns `REPORT_PATH`.
- **Depth**: only the primary `research` agent orchestrates; `@sources`, `@research-assistant`, and `@deep-research` are leaves (depth 1) and do not spawn further sub-agents.

## claim-merge.py (script)

`skills/research-workflow/scripts/claim-merge.py` cross-references multiple claim ledgers into a corroboration/conflict/unique matrix (a numeric/date/name safety-net). It is invoked by `@deep-research`; full usage is inlined in `agent/deep-research.md`.
