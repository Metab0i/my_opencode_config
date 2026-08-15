# Source Verification

Domain-aware source selection and academic paper search. Two scripts power this skill:

1. **source-picker.py** — Given a domain, returns the tiered source list from the JSON catalogue.
2. **academic-search.py** — Searches PubMed, arXiv, Semantic Scholar, DOAJ, and Europe PMC in parallel, deduplicates, and optionally fetches open-access full text.

## Setup

The source catalogue is stored as JSON at `~/.config/opencode/skills/source-verification/source_catalogue.json`. Edit this file directly to add or modify sources. No markdown rendering step is needed.

---

## source-picker.py

Returns the Tier 1/2/3 sources for a given domain as JSON.

### Invocation

```bash
# Get sources for a specific domain
python3 ~/.config/opencode/skills/source-verification/scripts/source-picker.py --domain "Science & Academia"

# List all available domains
python3 ~/.config/opencode/skills/source-verification/scripts/source-picker.py --list-domains
```

Domain matching is case-insensitive substring (e.g., `medicine` matches `Medicine & Health`).

> **Tip for agents**: To classify a query's domain, first run `--list-domains` and pick the matching catalogue key (e.g. `Science & Academia`, `Medicine & Health`, `Law & Legal`, `Statistics, Economics & Data`, `News & Current Events`, `Philosophy & Humanities`, `Technology & Web Development`, `General / Unclassified`). Do not assume a hardcoded list — always confirm against `--list-domains`.

### Output

```json
{
  "domain": "Science & Academia",
  "tier1": [ { "name": "...", "url": "...", "access": "...", "notes": "...", "academic_search_engine": true } ],
  "tier2": [ ... ],
  "tier3": [ ... ],
  "selection_rules": [ ... ],
  "discovery_protocol": [ ... ]
}
```

The `academic_search_engine` flag (true/false) marks sources that `academic-search.py` can query directly. Use `webfetch` for all others.

---

## academic-search.py

Searches 5 academic APIs in parallel, normalizes results to a unified schema, deduplicates by DOI (with title-similarity fallback), and optionally fetches OA full text.

### Invocation

```bash
# Default: all 5 engines, 5 results each, metadata + abstract only
python3 ~/.config/opencode/skills/source-verification/scripts/academic-search.py "quantum entanglement"

# Specific engines, custom limit
python3 ~/.config/opencode/skills/source-verification/scripts/academic-search.py "CRISPR" --engines pubmed,epmc --limit 10

# Full OA text mode (slower — fetches JATS XML from Europe PMC)
python3 ~/.config/opencode/skills/source-verification/scripts/academic-search.py "quantum entanglement" --full-text --limit 3

# All options combined
python3 ~/.config/opencode/skills/source-verification/scripts/academic-search.py "mRNA vaccine" --engines pubmed,arxiv,s2,doaj,epmc --limit 10 --full-text
```

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `QUERY` (positional) | — | Search query |
| `--engines` | `pubmed,arxiv,s2,doaj,epmc` | Comma-separated engine names |
| `--limit` | `5` | Results per engine (max 20) |
| `--full-text` | off | Fetch OA full text (JATS XML via Europe PMC) |

### Engine Reference

| Engine | Code | Coverage | OA Full Text |
|--------|------|----------|-------------|
| PubMed | `pubmed` | Biomedical, life sciences (40M+ citations) | Via PMC ID → EPMC JATS XML |
| arXiv | `arxiv` | Physics, math, CS, stats preprints | All arXiv is OA; PDF link only (no JATS) |
| Semantic Scholar | `s2` | Broad academic (214M+ papers) | `openAccessPdf.url` → PDF link only |
| DOAJ | `doaj` | Curated open-access journals | All DOAJ is OA; full-text URL only |
| Europe PMC | `epmc` | Biomedical + bioRxiv/medRxiv preprints | JATS XML via `fullTextXML` endpoint |

### Suggested Engine Combinations by Domain

| Domain | Engines |
|--------|---------|
| Medicine / Health | `pubmed,epmc` |
| Physics | `arxiv,epmc` |
| Computer Science | `arxiv,s2` |
| Biology / Life Sciences | `pubmed,epmc,doaj` |
| Broad / General academic | `s2,pubmed,arxiv,epmc,doaj` |

### Output Format

```json
{
  "query": "quantum entanglement",
  "engines_searched": ["pubmed", "arxiv", ...],
  "full_text_mode": false,
  "total_results": 12,
  "results": [ { ... unified result objects ... } ],
  "engine_stats": {
    "pubmed": { "found": 5, "errors": null },
    "s2": { "found": 0, "errors": "HTTP 429: ..." }
  },
  "caveats": [ "arXiv rate limit: ...", "Full text available only for ..." ],
  "error": null
}
```

### Result Object Fields

| Field | Description |
|-------|-------------|
| `title` | Article title |
| `authors` | List of author name strings |
| `year` | Publication year (integer or null) |
| `abstract` | Full abstract text or null |
| `doi` | DOI (lowercase, or null) |
| `url` | Best available URL (DOI, then source-specific) |
| `source` | Engine that found this result: `pubmed`, `arxiv`, `s2`, `doaj`, `epmc` |
| `source_id` | Engine-specific ID (PMID, arXiv ID, S2 paper ID, DOAJ record ID, EPMC ID) |
| `is_open_access` | Boolean — whether the paper is OA |
| `full_text_url` | URL to the full text (PDF, HTML, or DOI resolver) or null |
| `full_text` | Plain text extracted from JATS XML (only if `--full-text` and available from EPMC) or null |
| `journal` | Journal name or null |
| `keywords` | List of keyword strings |
| `matched_engines` | List of engines that returned this same paper (after dedup) |
| `pmc_id` | PubMed Central ID (if available) |

### Deduplication

Results are merged across engines:
- **Primary**: Same DOI (case-insensitive) → merged into one entry with `matched_engines` listing all engines that found it.
- **Fallback**: For results without DOIs, normalized title similarity (Jaccard > 0.85) triggers a merge.
- **Merge strategy**: Longest abstract wins, richest author list wins, OA flag is true if any engine says so, full text URL from first available.

### Full Text (`--full-text` flag)

When enabled, the script attempts to fetch open-access full text as plain text:

1. **EPMC results with `source == "PMC"`**: Fetches JATS XML directly via `rest/PMC{id}/fullTextXML`.
2. **EPMC results with `source == "MED"` and `inPMC == "Y"`**: Looks up the PMC-deposited version by DOI.
3. **PubMed results with `pmc_id`**: Uses the PMC ID directly via the EPMC endpoint.
4. **PubMed results without `pmc_id`**: Falls back to DOI lookup in EPMC.
5. **PDF-only sources** (arXiv, S2, DOAJ): Returns `full_text_url` (PDF link) but `full_text` remains null — the agent must use `webfetch` on the URL to read the PDF.

`full_text` is truncated to 50,000 characters. If fetch fails, `full_text` stays null and `_full_text_error` is set. This is expected for many papers — only a subset of OA papers have JATS XML deposited in Europe PMC.

> **Persisting OA full text for downstream agents**: `@sources` should NOT pass large `full_text` blobs through subagent boundaries. Instead, write each result's `full_text` (when present) to a `/tmp/oa_<n>.txt` file, and record that path on the source in its output manifest as `full_text_path`. For PDF-only OA results (arXiv, S2, DOAJ), record `full_text_url` and leave `full_text_path` null — the downstream `@research-assistant` will `webfetch` the PDF itself. This keeps the `@sources → @research-assistant` handoff cheap and avoids truncation.

### Rate Limits

| Engine | Limit | Handling |
|--------|-------|----------|
| PubMed | 3 req/s (no key) | 2 sequential calls (ESearch→EFetch), well within limit |
| arXiv | 1 req / 3 seconds | Single call satisfies the rule |
| Semantic Scholar | 1000/s shared pool (frequent 429s) | Exponential backoff (3 retries: 1s, 2s, 4s) |
| DOAJ | 2 req/s | Single call |
| Europe PMC | ~3 req/s recommended | Single search call + N full-text calls (0.3s delay between) |

If an engine returns an error, it's reported in `engine_stats` but the other engines' results still appear. The script always exits 0; errors are included in the JSON.

### Optional: Semantic Scholar API Key

Set `SEMANTIC_SCHOLAR_API_KEY` environment variable to avoid 429s:

```bash
export SEMANTIC_SCHOLAR_API_KEY="your-key"
python3 ~/.config/opencode/skills/source-verification/scripts/academic-search.py "query" --engines s2
```

### Important Caveats

- **JATS XML is not universally available**: Full text only works for papers deposited in Europe PMC. Many older OA papers and some preprints (e.g., older bioRxiv) lack JATS XML.
- **Semantic Scholar frequently 429s**: The shared unauthenticated pool is heavily contested. Get an API key or accept intermittent failures.
- **arXiv results have no DOIs**: Dedup relies on title similarity for arXiv papers. Papers cross-listed in arXiv and Semantic Scholar may not always merge if S2 also lacks the DOI.
- **Europe PMC "MED" source records are PubMed metadata**: They share PMIDs. PubMed + EPMC overlap is high; dedup merges these by DOI when available.