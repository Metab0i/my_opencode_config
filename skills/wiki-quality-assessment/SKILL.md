# Wikipedia Quality Assessment

Assess the reliability of any Wikipedia article before using it as a source. This skill produces a composite quality tier (A/B/C/D) based on multiple signals.

## When to Use

Always run this assessment whenever a Wikipedia article is cited or used as a source, regardless of the topic or agent.

## Assessment Procedure

### Step 1: Get the Latest Revision ID

```
GET https://en.wikipedia.org/w/api.php?action=query&titles=ARTICLE_TITLE&prop=revisions&rvprop=ids&rvlimit=1&format=json
```

Extract `revid` from the response. Use the article title with underscores instead of spaces (e.g., `Python_(programming_language)`).

### Step 2: Get ML Quality Prediction (Lift Wing)

```
POST https://api.wikimedia.org/service/lw/inference/v1/models/enwiki-articlequality:predict
Content-Type: application/json

{"rev_id": <revid>}
```

Response contains a `prediction` (FA, GA, A, B, C, Start, Stub) and `probability` scores for each grade.

If Lift Wing fails, fall back to ORES (legacy):
```
GET https://ores.wikimedia.org/v3/scores/enwiki?models=wp10&revids=<revid>
```

### Step 3: Get Human-Assessed Grade (Talk Page Categories)

```
GET https://en.wikipedia.org/w/api.php?action=query&titles=Talk:ARTICLE_TITLE&prop=categories&cllimit=500&format=json&formatversion=2
```

Parse category names for patterns like "B-Class", "GA-Class", "FA-Class", "C-Class", "Start-Class", "Stub-Class". Extract the highest grade found.

### Step 4: Get Page Metadata

```
GET https://en.wikipedia.org/w/api.php?action=query&titles=ARTICLE_TITLE&prop=info&inprop=protection|watchers|length&format=json
```

Extract:
- `protection`: Array of protection rules. Empty = unprotected. Non-empty = semi/fully protected.
- `watchers`: Number of users watching the page.
- `length`: Article size in bytes of wikitext.

### Step 5: Check for Citation Gaps

```
GET https://en.wikipedia.org/w/api.php?action=query&titles=ARTICLE_TITLE&prop=categories&cllimit=500&format=json&formatversion=2
```

Check if any category matches:
- `Category:All articles with unsourced statements`
- `Category:Articles with unsourced statements`
- `Category:Articles needing additional references`

Presence of these categories indicates sourcing problems.

### Step 6: Compute Composite Tier

Score each signal on a 0-1 scale:

| Signal | Scoring |
|--------|---------|
| ML Prediction | FA=1.0, GA=0.85, A=0.75, B=0.6, C=0.4, Start=0.2, Stub=0.1 |
| Human Grade | Same scale as ML. If no human grade found, use 0.5 (neutral). |
| Protection | Protected (any level) = +0.1 bonus. Unprotected = 0. |
| Watchers | >1000 = +0.1, 500-1000 = +0.05, <500 = 0 |
| Citation Gaps | No gap categories = +0.1, gap categories present = -0.2 |
| Length | >50KB = +0.05, 10-50KB = 0, <10KB = -0.1 |

**Composite score** = average of ML + Human grade, then add/subtract bonuses and penalties.

Clamp the final score to [0, 1].

### Step 7: Assign Tier

| Score Range | Tier | Meaning |
|-------------|------|---------|
| 0.80 - 1.00 | **A** | Featured/Good article, protected, heavily watched, well-cited. Highly reliable. |
| 0.60 - 0.79 | **B** | Solid article, decent sourcing, active community. Moderately reliable. |
| 0.40 - 0.59 | **C** | Incomplete but not necessarily wrong. Needs verification from other sources. |
| 0.00 - 0.39 | **D** | Stub or start article. Treat as orientation only, not as evidence. |

## Output Format

When reporting the assessment, use this format:

```
Wikipedia Quality Assessment: [ARTICLE_TITLE]
- ML Prediction: [grade] (confidence: [probability])
- Human Grade: [grade] or "No human assessment found"
- Protection: [unprotected / semi-protected / fully protected]
- Watchers: [count]
- Citation Gaps: [none found / X gap categories detected]
- Article Length: [bytes]
- Composite Tier: [A/B/C/D] ([score])
```

## Important Caveats

- **ML models assess structure, not content quality**: The Lift Wing/ORES model predicts based on structural features (sections, infoboxes, reference templates), not factual accuracy or tone.
- **Human assessments can be stale**: WikiProject grades are manually applied and may be months or years out of date.
- **Not all articles are assessed**: Only a fraction of English Wikipedia articles have human-assigned grades.
- **Tier is not a guarantee**: Even Tier A articles can contain errors. Always cross-reference with primary sources when possible.
- **Wikipedia is never a primary source**: Even at Tier A, Wikipedia is a tertiary summary. Use it for orientation, not as definitive evidence.
