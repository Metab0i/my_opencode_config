# Wikipedia Quality Assessment

Assess the reliability of any Wikipedia article and its references before using it as a source. This skill runs an automated script that produces a JSON report with article metadata, quality signals (weighted ensemble model), reference analysis (Parsoid HTML parsing), and community engagement metrics.

## When to Use

Always run this assessment whenever a Wikipedia article is cited or used as a source, regardless of the topic or agent.

## How to Invoke

```bash
python3 ~/.config/opencode/skills/wiki-quality-assessment/scripts/wiki-article-assessment.py "Article Title"
```

The script outputs a single JSON object to stdout. It always exits 0 — errors are included in the JSON as an `"error"` field.

## Output Interpretation

### Top-Level Fields

| Field | Description |
|-------|-------------|
| `article` | Page metadata (title, URL, rev ID, last modified, days since edit, size, watchers, protection) |
| `quality_signals` | Quality assessment: ML prediction, human grade, composite score, tier, and per-component breakdown |
| `references` | Reference analysis from Parsoid HTML (unique count, reused count, DOI/ISBN/URL counts, type breakdown, density) |
| `community` | Community engagement (pageviews last 60d, avg daily views, unique editors, recent edit frequency) |
| `maintenance` | Maintenance signals (citation gap categories, dispute templates, cleanup templates, has-no-references flag) |
| `caveats` | List of limitations and warnings about the assessment |
| `error` | `null` on success, error message string on failure |

### Tier → Trust Mapping

| Tier | Score Range | Meaning | How to Treat |
|------|------------|---------|--------------|
| **A** | 0.80–1.00 | Featured/Good article, well-sourced, strong community | Highly reliable supplementary source. Cross-reference still recommended. |
| **B** | 0.60–0.79 | Solid article, decent sourcing, some community oversight | Moderately reliable. Verify key claims against primary sources. |
| **C** | 0.40–0.59 | Incomplete or underdeveloped, limited sourcing | Needs verification from other sources before relying on it. |
| **D** | 0.00–0.39 | Stub or start article, minimal sourcing | Treat as orientation only, not as evidence. Find better sources. |

### `quality_signals` Fields

| Field | Description |
|-------|-------------|
| `ml_prediction.grade` | ML model's top predicted quality grade (FA, GA, A, B, C, Start, Stub) |
| `ml_prediction.probability` | Confidence in the top predicted grade |
| `ml_prediction.all_probabilities` | Full probability distribution across all grades |
| `human_grade.highest` | Highest WikiProject-assessed grade (or `null` if none found) |
| `human_grade.grades_by_wikiproject` | All WikiProject grades found on Talk page |
| `human_grade.disagreement` | `true` if WikiProjects disagree on the grade |
| `composite_score` | Weighted ensemble score (0.0–1.0) combining all components |
| `tier` | Final quality tier (A/B/C/D) derived from composite score |
| `components` | Per-component scores for transparency (see below) |

### `quality_signals.components` (Ensemble Model)

| Component | Weight | What it measures |
|-----------|--------|------------------|
| `ml_quality` | 25% | ML expected value: `sum(grade_value × probability)` across all grades |
| `human_grade` | 20% | WikiProject-assessed grade from Talk page (null if absent — weight redistributed) |
| `reference_quality` | 30% | Ref density, type quality (academic vs web), URL coverage, citation-needed penalty |
| `community_engagement` | 15% | Protection, watchers, pageviews, editor diversity, edit frequency |
| `maintenance` | 10% | Inverted: citation gaps, dispute templates, cleanup templates, no-references flag |

When `human_grade` is absent, its 20% weight redistributes to `ml_quality` (35%), `reference_quality` (35%), `community_engagement` (20%), `maintenance` (10%).

### `references` Fields

| Field | Description |
|-------|-------------|
| `total_count` | Unique reference definitions (deduplicated by cite_note ID) |
| `reused_count` | Named references reused (not counted in total) |
| `footnote_count` | Footnote group refs (excluded from total — these are explanatory, not sources) |
| `with_doi` | References containing DOI links |
| `with_isbn` | References containing ISBN links |
| `with_urls` | References containing at least one URL |
| `ref_types.book` | References classified as books (ISBN / `{{Cite book}}` template) |
| `ref_types.journal` | References classified as journals (DOI / `{{Cite journal}}` template) |
| `ref_types.news` | References classified as news (`{{Cite news}}` template or news keywords) |
| `ref_types.web` | References with URLs but no DOI/ISBN/news markers |
| `ref_types.other` | References with none of the above markers (e.g., {{harvtxt}}, {{sfn}}) |
| `citation_needed_count` | Number of `{{citation needed}}` / `{{cn}}` templates |
| `external_links_total` | Count of external links on the page (from MediaWiki API) |
| `ref_density` | References per 1000 bytes (higher = more densely sourced) |
| `type_quality_ratio` | `(journal + book) / total` — fraction of academic references |

### `community` Fields

| Field | Description |
|-------|-------------|
| `pageviews_last_60d` | Total page views over the last 60 days (human traffic, excludes bots) |
| `avg_daily_views` | Average page views per day over the last 60 days |
| `unique_editors_500` | Unique editors in the last 500 revisions (high = collaboratively maintained) |
| `edits_last_90d` | Number of edits in the last 90 days |
| `days_since_last_edit` | Days since the most recent edit (null if unavailable) |

### `maintenance` Fields

| Field | Description |
|-------|-------------|
| `citation_gap_categories` | List of maintenance categories indicating sourcing problems |
| `dispute_templates` | Dispute templates detected (NPOV, Disputed, Controversial, etc.) |
| `cleanup_templates` | Cleanup templates detected (Cleanup, CopyEdit, Wikify, etc.) |
| `has_no_references` | `true` if the article has zero references |

### Error Handling

If the script encounters an error (e.g., article not found, API failure), the JSON will contain:

```json
{
  "article": {"title": "..."},
  "quality_signals": {},
  "references": {},
  "caveats": [],
  "error": "Article not found"
}
```

Check the `error` field before processing the rest of the JSON.

## Important Caveats

- **ML models assess structure, not content quality**: The Lift Wing/ORES model predicts based on structural features (sections, infoboxes, reference templates), not factual accuracy or tone.
- **Human assessments can be stale**: WikiProject grades are manually applied and may be months or years out of date.
- **Not all articles are assessed**: Only a fraction of English Wikipedia articles have human-assigned grades.
- **Reference classification uses Parsoid HTML**: The script parses rendered HTML (via MediaWiki's REST API) to classify references by `<cite>` element class attributes. Misclassification is possible for non-standard citation templates.
- **Tier is not a guarantee**: Even Tier A articles can contain errors. Always cross-reference with primary sources when possible.
- **Wikipedia is never a primary source**: Even at Tier A, Wikipedia is a tertiary summary. Use it for orientation, not as definitive evidence.
- **Pageviews cover last 60 days only**: Provided by the MediaWiki Action API, capped at 60 days.

## Optional: Lift Wing API Token

The script uses the Lift Wing API anonymously by default (50,000 requests/hour). To raise rate limits, set the `WIKILIFT_TOKEN` environment variable:

```bash
export WIKILIFT_TOKEN="your-token-here"
python3 ~/.config/opencode/skills/wiki-quality-assessment/scripts/wiki-article-assessment.py "Article Title"
```

If Lift Wing fails, the script automatically falls back to the legacy ORES API.