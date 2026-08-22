---
name: research-workflow
description: Multi-source research workflow. Extraction checklist and JSON claim-ledger schema for per-source fact extraction (Research Assistant), the orchestrator pipeline that fans out assistants and hands ledger files to the synthesizer (Research orchestrator), claim-merge.py that cross-references multiple ledgers into a corroboration/conflict matrix, and the synthesis framework + report template for the Deep Research synthesizer.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: research-synthesis
---

# Research Workflow

This skill defines the multi-source research pipeline used by the Research agents. It has four parts:

1. **Extraction methodology** (sections 2-5) — for the Research Assistant agent, which extracts facts from a single source into a `~/tmp/ledger_<id>.json` file.
2. **claim-merge.py** (section 6) — a script, run by the Deep Research synthesizer, that cross-references multiple Research-Assistant claim ledgers.
3. **Synthesis framework & report template** (sections 7-8) — for the Deep Research synthesizer that compiles the final report.

> **Orchestration lives in the primary `research` agent** (depth 0): it calls `@sources`, fans out N × `@research-assistant` (one per source), collects each `LEDGER_PATH`, and hands the ledger file paths to `@deep-research`. The sub-agents are leaves and do not launch further sub-agents (depth 1).

## Roles

| Agent | Mode | Reads | Responsibility |
|-------|------|-------|----------------|
| Research (orchestrator) | primary, depth 0 | Pipeline (not this skill's sections) | Route the query: `@sources` → fan out N × `@research-assistant` (one per source) → collect each `LEDGER_PATH` → hand ledger file paths to `@deep-research` → present the report |
| Research Assistant | subagent, leaf | Sections 2-5 | Extract all relevant facts from ONE assigned source into a `~/tmp/ledger_<id>.json` ledger file (Write tool) and return a `LEDGER_PATH:` line |
| Deep Research (synthesizer) | subagent, leaf | Sections 6-8 | Run `claim-merge.py` on the ledger file paths received from the orchestrator, then compile the final cross-referenced report |

### Data flow & file contract

```
@sources            → source manifest (+ full_text_path ~/tmp/oa_<n>.txt where OA)
@research-assistant → ~/tmp/ledger_<id>.json  (written via Write tool) + "LEDGER_PATH: ~/tmp/..." response line
@deep-research     ← receives ledger file paths from orchestrator → claim-merge.py → report
```

- **OA full text**: `@sources` writes plain text to `~/tmp/oa_<n>.txt` and passes `full_text_path` to `@research-assistant` — this avoids funneling up to 50k-char blobs through subagent boundaries.
- **Claim ledgers**: each `@research-assistant` writes its own `~/tmp/ledger_<id>.json` (JSON object = `source` + `facts[]` per §5) and returns a path, so the orchestrator never parses JSON out of prose and `claim-merge.py` consumes files directly.
- **Reuse & checkpointing**: a plugin (`research-orchestrator.ts`) records each source URL → `{ ledger_path, status, mtime }` in `~/tmp/research_state.json` after extraction, and records each report after synthesis. The orchestrator reads that file before extracting/synthesizing to reuse fresh artifacts instead of re-running work.
- **Report filename**: the orchestrator owns the report filename and passes the exact `~/research/research_report_<ts>.md` path to `@deep-research`, which must write there (not invent its own name) and verify the file exists before returning `REPORT_PATH`.
- **Depth**: only the primary `research` agent orchestrates; `@sources`, `@research-assistant`, and `@deep-research` are leaves (depth 1) and do not spawn further sub-agents.

---

## 2. Extraction Checklist (Research Assistant)

When extracting from a source, pull every relevant fact that pertains to the user's query. Specifically look for:

- **Claims**: Assertions, conclusions, or findings stated by the source
- **Numbers / Statistics**: Quantitative data, percentages, counts, measurements
- **Dates**: Publication dates, event dates, timelines
- **Names**: People, organizations, institutions, projects
- **Places**: Geographic locations, institutions, facilities
- **Definitions**: Key term definitions or conceptual explanations
- **Direct quotes**: Notable verbatim statements from the source (cap at 300 characters)
- **Methodology**: How the study was conducted, experimental design, data sources
- **References**: Citations to other works that are themselves relevant to the user's query

Scope strictly to the user's query. Do not extract tangential information. If a fact is borderline-relevant, extract it but mark confidence as "low".

## 3. Claim Taxonomy

Each extracted fact has a `type` field with one of these values:

| Type | When to use |
|------|-------------|
| `claim` | An assertion, conclusion, or finding |
| `number` | A bare number (count, measurement) without surrounding claim context |
| `statistic` | A number in context (percentage, rate, ratio, magnitude) |
| `date` | A calendar date or date range |
| `name` | A person, organization, or project name |
| `place` | A geographic or institutional location |
| `definition` | A term definition or conceptual explanation |
| `quote` | A direct verbatim excerpt from the source |
| `methodology` | Experimental or analytical method description |
| `reference` | A citation to another work relevant to the query |

## 4. Output Format — Ledger File + Status Line

The Research Assistant does NOT paste the ledger into its response. It writes the full claim ledger (a JSON object matching the schema in Section 5) to a `~/tmp` file via the **Write tool**, then returns a brief prose status ending with a `LEDGER_PATH:` line. The orchestrator forwards that path to `@deep-research`, which feeds it to `claim-merge.py`.

### Part 1: The ledger file

Using the Write tool, write a JSON object to `~/tmp/ledger_<id>.json` (a short unique id, e.g. `~/tmp/ledger_f1.json`). The object contains the `source` metadata and the `facts[]` array:

```json
{
  "source": {
    "url": "https://...",
    "title": "...",
    "publication": "...",
    "date": "YYYY-MM-DD or null",
    "quality_score": 4
  },
  "facts": [
    {
      "id": "f1",
      "type": "statistic",
      "value": "Paraphrased fact statement",
      "verbatim": "Exact quote (max 300 chars) or null",
      "location": "Section/paragraph where found",
      "confidence": "high",
      "topic_tags": ["quantum", "fidelity"]
    }
  ]
}
```

### Part 2: The response status line

Your response text stays short: a one-line status (source title, number of facts extracted, max confidence), and as the **absolute last line**, the contract line in this exact form:

```
LEDGER_PATH: ~/tmp/ledger_<id>.json
```

Do not paste the ledger JSON into your response — it lives in the file. If the source is inaccessible, still write a ledger file with an empty `facts[]` and the `source` metadata, then return the `LEDGER_PATH:` line pointing at it.

## 5. JSON Claim Ledger Schema

| Field | Type | Description |
|-------|------|-------------|
| `source.url` | string | Source URL |
| `source.title` | string | Source title |
| `source.publication` | string | Publication or venue name |
| `source.date` | string or null | Publication date (ISO if possible) |
| `source.quality_score` | integer | 1-5 score from @sources verification |
| `facts[]` | array | List of extracted facts |
| `facts[].id` | string | Sequential ID: "f1", "f2", ... |
| `facts[].type` | string | One of the claim taxonomy types |
| `facts[].value` | string | Paraphrased fact statement (your words) |
| `facts[].verbatim` | string or null | Exact quote from source (max 300 chars) if available |
| `facts[].location` | string | Where in the source this was found (section, paragraph) |
| `facts[].confidence` | string | "high", "medium-high", "medium", or "low" |
| `facts[].topic_tags` | array of strings | Short tags for topical grouping |

Confidence levels:
- **high**: Fact is explicitly stated, unambiguous, directly relevant to the query
- **medium-high**: Fact is clearly stated but requires minor interpretation
- **medium**: Fact is relevant but may be contextually dependent or partially inferred
- **low**: Fact is borderline-relevant or the source's language is ambiguous

---

## 6. claim-merge.py

Cross-references multiple Research-Assistant claim ledgers and produces a corroboration/conflict/unique matrix. It is invoked by the **Deep Research synthesizer** (the `@deep-research` agent), which receives the ledger file paths from the orchestrator.

### Invocation

```bash
# File mode — @deep-research calls this with the ledger paths handed to it by the orchestrator,
# writing the merge matrix to a file so large outputs never flood the agent's context:
python3 ~/.config/opencode/skills/research-workflow/scripts/claim-merge.py ~/tmp/ledger_1.json ~/tmp/ledger_2.json ~/tmp/ledger_3.json --out ~/tmp/merge_<ts>.json

# Stdin mode — pipe a JSON array of ledgers (alternative):
echo '[{...},{...}]' | python3 ~/.config/opencode/skills/research-workflow/scripts/claim-merge.py
```

Each `@research-assistant` already writes its own `~/tmp/ledger_<id>.json`, so **file mode** is the default — no heredoc shell-escaping is needed.

### How It Clusters Facts

`claim-merge.py` is a **numeric/date/name safety-net, not a corroboration engine**. It only reliably clusters low-ambiguity fact types:

| Fact type | Matching method |
|-----------|---------------|
| `number`, `statistic` | Numeric value match within 5% tolerance **and** at least one shared `topic_tag` |
| `date` | Normalized text match (ISO-like) |
| `name`, `place` | Case-insensitive exact match (punctuation stripped) |
| `quote` | Normalized verbatim text exact match |

Free-text `claim`, `definition`, `methodology`, and `reference` facts are **not** clustered — paraphrase/semantic corroboration across differently-authored ledgers cannot be done reliably by token overlap and is left to the synthesizer's manual reading of the ledger `value` fields.

Facts from the **same source URL are never clustered** — corroboration requires distinct sources.

### Output Schema

```json
{
  "total_sources": 3,
  "total_facts": 14,
  "corroborated": [
    {
      "fact": "Paraphrased fact statement",
      "type": "statistic",
      "sources": ["url1", "url2"],
      "source_count": 2,
      "verbatims": ["verbatim quote 1", "verbatim quote 2"],
      "topic_tags": ["quantum", "fidelity"],
      "max_confidence": "high"
    }
  ],
  "unique": [
    {
      "fact": "...",
      "type": "claim",
      "source": "url",
      "source_title": "...",
      "quality_score": 4,
      "confidence": "medium",
      "topic_tags": ["..."],
      "verbatim": "..." or null
    }
  ],
  "conflicts": [
    {
      "topic": "Paraphrased fact description",
      "type": "statistic",
      "variants": [
        {"value": "99.2%", "verbatim": "...", "source": "url1", "source_title": "..."},
        {"value": "95.8%", "verbatim": "...", "source": "url2", "source_title": "..."}
      ],
      "sources": ["url1", "url2"],
      "topic_tags": ["..."]
    }
  ],
  "caveats": [
    "Conflict detection is exact for numbers, statistics, and dates; claim-text conflicts are auto-detected by semantic similarity only.",
    "Facts from the same source are never clustered together."
  ],
  "error": null
}
```

### Categories

| Category | Meaning |
|----------|---------|
| **corroborated** | Same fact found in ≥2 distinct sources. Use as backbone of the report. |
| **unique** | Fact found in only 1 source. Use for depth and context. Weight by source quality_score. |
| **conflicts** | Same numeric/date fact with divergent values across sources. Present both variants with attribution. |

### Caveats

- Conflict detection is **exact for numbers, statistics, and dates**. Claim-text polarity conflicts (e.g., "X is true" vs "X is false") are NOT auto-detected — the Research agent must catch those manually during synthesis.
- Free-text claim corroboration is intentionally not automated; numeric corroboration requires shared `topic_tags` to avoid false positives (e.g., an unrelated bus-bandwidth figure matching a memory-bandwidth figure).

---

## 7. Synthesis Framework (Deep Research Synthesizer)

After running claim-merge.py, turn the cross-reference matrix into a coherent report using these rules:

### Fact Classification → Confidence

| Situation | Confidence | How to report |
|-----------|------------|---------------|
| Corroborated by 2+ Tier 1 sources | **high** | Report as established fact |
| Corroborated by 2+ sources (any tier) | **medium-high** | Report with inline citations |
| Unique fact from Tier 1 source (quality 4-5) | **medium** | Report with single citation |
| Unique fact from Tier 2 source (quality 3) | **medium-low** | Report with caveat about single-source status |
| Unique fact from Tier 3 source (quality 1-2) | **low** | Flag explicitly as unverified |
| Conflict between sources | **contested** | Present all variants with attribution; explain which is more trustworthy and why |

### Conflict Resolution

When sources conflict:
1. Present both/all variants explicitly
2. Attribute each to its source with the source's quality_score
3. Explain which source is more trustworthy and why:
   - Higher quality_score wins
   - More recent publication wins if topic is time-sensitive
   - Primary source (original research) wins over secondary (commentary)
   - Peer-reviewed wins over non-peer-reviewed
4. If neither source clearly dominates, present both and note the disagreement as an unresolved question

### Recency Checks

- Flag any source older than 5 years for time-sensitive domains (Medicine, News, Tech)
- For foundational/scientific topics, older sources may still be authoritative
- If a newer source supersedes an older finding, note the supersession

---

## 8. Report Template

The Deep Research synthesizer's final output uses this structure:

```
## Summary

Concise overview of findings (2-3 paragraphs). State the key conclusions and overall confidence level.

## Findings

Detailed findings with inline numbered citations [1], [2], etc. For each claim:
- Include a confidence level (high/medium/low) based on source quality and consensus
- When using field-specific concepts, provide a link to look up their meaning
- Group findings by subtopic for readability
- Lead with corroborated facts, follow with unique findings, flag conflicts

## Critiques

If relevant to the research topic, present notable critiques, counterarguments, or limitations of the positions discussed. Source these from the claim ledgers.

## Unresolved Questions

List anything that could not be corroborated or remains unclear. Include:
- Single-source claims that couldn't be verified
- Conflicts that couldn't be resolved
- Topics where no source provided sufficient depth

## Sources

Full list of all web resources used, numbered to match inline citations:
1. URL, title, publication, date, quality_score (1-5)
2. ...

Each source entry should note which Research-Assistant extracted it (by source URL matching).
```

### Important Notes for the Deep Research Synthesizer

- **Run claim-merge.py as a safety-net, not a corroboration engine**: it catches numeric/date/name conflicts and numeric agreements you might miss by eye. Establish free-text corroboration yourself by reading the ledger `value` fields across sources.
- **Use `--out ~/tmp/merge_<ts>.json`**: write the merge matrix to a file and read it in chunks rather than dumping a large JSON blob into your context.
- **Facts from the merge matrix are pre-normalized** for the types it clusters (numbers, statistics, dates, names, places, quotes). Do not re-interpret or re-check those unless something seems wrong.
- **The merge matrix does NOT detect semantic claim conflicts**: "X causes Y" vs "X does not cause Y" won't be flagged by the script. You must read the claim-ledgers for this.
- **Always include the conflict context**: When reporting a conflict, show the divergent values with their sources so the user can judge.