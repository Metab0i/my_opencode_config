---
name: research-workflow
description: Multi-source research workflow. Extraction checklist and JSON claim-ledger schema for per-source fact extraction (Research Assistant), synthesis framework and report template for compiling one report (Research agent), and claim-merge.py that cross-references multiple ledgers into a corroboration/conflict matrix.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: research-synthesis
---

# Research Workflow

This skill defines the multi-source research pipeline used by the Research agents. It has three parts:

1. **Extraction methodology** (sections 2-5) — for the Research Assistant agent that extracts facts from a single source.
2. **claim-merge.py** (section 6) — a script that cross-references multiple Research-Assistant claim ledgers.
3. **Synthesis framework & report template** (sections 7-8) — for the Research agent that compiles the final report.

## Roles

| Agent | Reads | Responsibility |
|-------|-------|----------------|
| Research Assistant | Sections 2-5 | Extract all relevant facts from ONE assigned source into a hybrid summary + JSON claim ledger |
| Research (orchestrator) | Sections 6-8 | Fan out assistants, run claim-merge.py, compile the final report |

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

## 4. Output Format — Hybrid

The Research Assistant returns a **hybrid output**: a formatted markdown prose summary followed by a fenced JSON block.

### Part 1: Formatted Summary

A markdown summary of the source keyed to the user's query. Use headings and bullet points. Group facts by subtopic. This is the human-readable view.

### Part 2: JSON Claim Ledger

The LAST thing in your output must be a fenced `json` code block containing the structured claim ledger. The Research agent extracts this block to pass to claim-merge.py.

**The JSON block must be the absolute last thing in your output.** Do not add text after it.

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

Cross-references multiple Research-Assistant claim ledgers and produces a corroboration/conflict/unique matrix.

### Invocation

```bash
# File mode — Research agent writes ledgers to temp files, then calls:
python3 ~/.config/opencode/skills/research-workflow/scripts/claim-merge.py /tmp/ledger1.json /tmp/ledger2.json /tmp/ledger3.json

# Stdin mode — pipe a JSON array of ledgers:
echo '[{...},{...}]' | python3 ~/.config/opencode/skills/research-workflow/scripts/claim-merge.py
```

The Research agent should use **file mode**: write each ledger to a temp file via bash heredoc, then invoke the script with those paths. This avoids shell-escaping issues with large JSON.

### How It Clusters Facts

| Fact type | Matching method |
|-----------|---------------|
| `number`, `statistic` | Numeric value match within 5% tolerance |
| `date` | Normalized text match (ISO-like) |
| `name`, `place` | Case-insensitive exact match (punctuation stripped) |
| `quote` | Normalized verbatim text exact match |
| `claim`, `definition`, `methodology`, `reference` | Jaccard text similarity ≥ 0.75, OR shared primary number + Jaccard ≥ 0.30 |

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
- Semantic similarity for claims uses Jaccard token overlap, which may miss paraphrased restatements. The numeric-value fallback helps but is not perfect.

---

## 7. Synthesis Framework (Research Agent)

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

The Research agent's final output uses this structure:

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

### Important Notes for the Research Agent

- **Do NOT skip the claim-merge step**: Even with 2 sources, the script catches numeric conflicts and corroborations that are easy to miss by eye.
- **Facts from the merge matrix are pre-normalized**: Use the `value` fields directly. Do not re-interpret or re-check the sources unless something seems wrong.
- **The merge matrix does NOT detect semantic claim conflicts**: "X causes Y" vs "X does not cause Y" won't be flagged by the script. You must read the claim-ledgers for this.
- **Always include the conflict context**: When reporting a conflict, show the divergent values with their sources so the user can judge.