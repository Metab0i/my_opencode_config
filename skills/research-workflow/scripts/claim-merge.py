#!/usr/bin/env python3
"""claim-merge.py — Cross-reference multiple Research-Assistant claim ledgers.

Reads N JSON claim-ledger files produced by @research-assistant agents,
clusters facts across sources, and outputs a corroboration/conflict/unique
matrix as JSON to stdout.

Usage:
    # File mode — pass ledger file paths
    python3 claim-merge.py ~/tmp/ledger1.json ~/tmp/ledger2.json ~/tmp/ledger3.json

    # File mode with output written to a file (recommended for large merges)
    python3 claim-merge.py ~/tmp/ledger1.json ... --out ~/tmp/merge.json

    # Stdin mode — pipe a JSON array of ledgers
    echo '[{...},{...}]' | python3 claim-merge.py

Each ledger must conform to the schema documented in research-workflow/SKILL.md:
    {
        "source": { "url", "title", "publication", "date", "quality_score" },
        "facts": [ { "id", "type", "value", "verbatim", "location",
                      "confidence", "topic_tags" } ]
    }

Output schema:
    {
        "total_sources": N,
        "total_facts": M,
        "corroborated": [ { "fact", "type", "sources", "source_count",
                            "verbatims", "topic_tags", "max_confidence" } ],
        "unique": [ { "fact", "type", "source", "quality_score",
                       "confidence", "topic_tags" } ],
        "conflicts": [ { "topic", "type", "variants",
                          "sources", "topic_tags" } ],
        "caveats": [ ... ],
        "error": null
    }
"""

import json
import re
import sys

# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

NUMERIC_EPSILON = 0.01
MAX_VERBATIM_LEN = 300


def normalize_text(text):
    """Lowercase, strip punctuation, collapse whitespace."""
    if not text:
        return ""
    t = text.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def extract_numeric(value):
    """Extract primary numeric value from a string like '42%' or '3.14 million'."""
    m = re.search(r"[-+]?\d[\d,]*\.?\d*", value)
    if not m:
        return None
    raw = m.group().replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def normalize_date(value):
    """Normalize a date string to ISO-ish YYYY-MM-DD if possible."""
    for fmt in (r"(\d{4})-(\d{2})-(\d{2})",
                r"(\d{4})/(\d{2})/(\d{2})",
                r"(\d{2})/(\d{2})/(\d{4})",
                r"(\d{4})-(\d{2})",
                r"(\d{4})\s+([A-Z][a-z]+)\s+(\d{1,2})"):
        m = re.search(fmt, value)
        if m:
            return normalize_text(value)
    return normalize_text(value)


# ---------------------------------------------------------------------------
# Fact model
# ---------------------------------------------------------------------------

class Fact:
    __slots__ = ("id", "type", "value", "verbatim", "location",
                 "confidence", "topic_tags", "source")

    def __init__(self, fdict, source_meta):
        self.id = fdict.get("id", "")
        self.type = fdict.get("type", "claim")
        self.value = fdict.get("value", "")
        self.verbatim = (fdict.get("verbatim") or "")[:MAX_VERBATIM_LEN]
        self.location = fdict.get("location", "")
        self.confidence = fdict.get("confidence", "medium")
        self.topic_tags = fdict.get("topic_tags", [])
        self.source = source_meta  # full source dict with url, title, etc.

    def display_verbatim(self):
        if self.verbatim:
            return f'"{self.verbatim}"'
        return ""


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def facts_match(f1, f2):
    """Determine if two facts refer to the same underlying information.

    Only low-ambiguity types are clustered: numbers, statistics, dates,
    names, places, and quotes. Free-text claim/definition/methodology
    clustering is intentionally omitted — it yields near-zero true
    corroboration and is left to the synthesizer's manual reading.
    """
    # Numbers / statistics: compare numeric values AND require a shared topic tag
    if f1.type in ("number", "statistic") and f2.type in ("number", "statistic"):
        n1 = extract_numeric(f1.value)
        n2 = extract_numeric(f2.value)
        if n1 is not None and n2 is not None:
            tags1 = set(f1.topic_tags or [])
            tags2 = set(f2.topic_tags or [])
            if not (tags1 & tags2):
                return False
            return abs(n1 - n2) < max(NUMERIC_EPSILON, abs(n1) * 0.05)

    # Dates: normalized text match
    if f1.type == "date" and f2.type == "date":
        d1 = normalize_date(f1.value)
        d2 = normalize_date(f2.value)
        return d1 and d2 and d1 == d2

    # Names / places: exact normalized match
    if f1.type in ("name", "place") and f2.type in ("name", "place"):
        return normalize_text(f1.value) == normalize_text(f2.value)

    # Quotes: exact normalized match (quotes are verbatim so should be identical)
    if f1.type == "quote" and f2.type == "quote":
        return normalize_text(f1.verbatim) == normalize_text(f2.verbatim)

    return False


def cluster_facts(all_facts):
    """Group facts into clusters of matching info, regardless of source."""
    clusters = []
    assigned = [False] * len(all_facts)

    for i, f in enumerate(all_facts):
        if assigned[i]:
            continue
        cluster = [i]
        assigned[i] = True
        for j in range(i + 1, len(all_facts)):
            if assigned[j]:
                continue
            # Don't cluster facts from the same source
            if all_facts[j].source.get("url") == f.source.get("url"):
                continue
            if any(facts_match(all_facts[k], all_facts[j]) for k in cluster):
                cluster.append(j)
                assigned[j] = True
        clusters.append(cluster)

    return clusters


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

CONFIDENCE_ORDER = {"high": 3, "medium-high": 2, "medium": 1, "low": 0}


def max_confidence(confidences):
    best = "low"
    for c in confidences:
        if CONFIDENCE_ORDER.get(c, 0) > CONFIDENCE_ORDER.get(best, 0):
            best = c
    return best


def classify_clusters(clusters, all_facts):
    corroborated = []
    unique = []
    conflicts = []

    for cluster_indices in clusters:
        cluster_facts = [all_facts[i] for i in cluster_indices]
        source_urls = [f.source.get("url", "") for f in cluster_facts]
        distinct_sources = set(source_urls)

        if len(distinct_sources) >= 2:
            # Check for conflicts on numeric/date types
            types = set(f.type for f in cluster_facts)
            has_numeric = any(t in ("number", "statistic", "date") for t in types)

            if has_numeric:
                # If values diverge, it's a conflict, not corroboration
                numeric_values = set()
                for f in cluster_facts:
                    if f.type in ("number", "statistic"):
                        n = extract_numeric(f.value)
                        if n is not None:
                            numeric_values.add(round(n, 2))
                    elif f.type == "date":
                        numeric_values.add(normalize_date(f.value))

                if len(numeric_values) > 1:
                    # Conflict
                    variants = []
                    for f in cluster_facts:
                        variants.append({
                            "value": f.value,
                            "verbatim": f.verbatim,
                            "source": f.source.get("url", ""),
                            "source_title": f.source.get("title", ""),
                        })
                    # Deduplicate variants by (value, source)
                    seen = set()
                    deduped_variants = []
                    for v in variants:
                        key = (v["value"], v["source"])
                        if key not in seen:
                            seen.add(key)
                            deduped_variants.append(v)

                    all_tags = []
                    for f in cluster_facts:
                        for tag in f.topic_tags:
                            if tag not in all_tags:
                                all_tags.append(tag)

                    conflicts.append({
                        "topic": cluster_facts[0].value[:100],
                        "type": list(types)[0],
                        "variants": deduped_variants,
                        "sources": sorted(distinct_sources),
                        "topic_tags": all_tags,
                    })
                    continue

            # Corroborated
            confidences = [f.confidence for f in cluster_facts]
            all_tags = []
            for f in cluster_facts:
                for tag in f.topic_tags:
                    if tag not in all_tags:
                        all_tags.append(tag)
            verbatims = [f.display_verbatim() for f in cluster_facts if f.verbatim]

            corroborated.append({
                "fact": cluster_facts[0].value,
                "type": cluster_facts[0].type,
                "sources": sorted(distinct_sources),
                "source_count": len(distinct_sources),
                "verbatims": verbatims,
                "topic_tags": all_tags,
                "max_confidence": max_confidence(confidences),
            })
        else:
            f = cluster_facts[0]
            unique.append({
                "fact": f.value,
                "type": f.type,
                "source": f.source.get("url", ""),
                "source_title": f.source.get("title", ""),
                "quality_score": f.source.get("quality_score", None),
                "confidence": f.confidence,
                "topic_tags": f.topic_tags,
                "verbatim": f.verbatim if f.verbatim else None,
            })

    # Sort corroborated by source_count descending, then by confidence
    corr_order = {"high": 3, "medium-high": 2, "medium": 1, "low": 0}
    corroborated.sort(key=lambda x: (-x["source_count"], -corr_order.get(x["max_confidence"], 0)))

    return corroborated, unique, conflicts


# ---------------------------------------------------------------------------
# Ledger loading
# ---------------------------------------------------------------------------

def load_ledger(filepath):
    """Load a single ledger JSON file."""
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data


def load_ledgers_from_stdin():
    """Read a JSON array of ledgers from stdin."""
    raw = sys.stdin.read().strip()
    if not raw:
        return []
    data = json.loads(raw)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    raise ValueError("Invalid stdin input: expected JSON array or object")


def parse_ledger_raw(raw):
    """Ensure a raw dict has source + facts; return (source_meta, facts_list) or raise."""
    source = raw.get("source", {})
    facts_raw = raw.get("facts", [])
    if not isinstance(source, dict):
        source = {}
    if not isinstance(facts_raw, list):
        facts_raw = []
    return source, facts_raw


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def emit(data, out_path):
    """Write the merge result to a file if --out was given, else stdout."""
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(payload + "\n")
    else:
        print(payload)


def main():
    argv = sys.argv[1:]

    # Parse --out <path> (or --out=<path>)
    out_path = None
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]
            i += 2
        elif arg.startswith("--out="):
            out_path = arg[len("--out="):]
            i += 1
        else:
            positional.append(arg)
            i += 1

    # Determine input mode
    raw_ledgers = []

    if not positional:
        # Stdin mode
        try:
            raw_ledgers = load_ledgers_from_stdin()
        except Exception as e:
            emit({
                "total_sources": 0,
                "total_facts": 0,
                "corroborated": [],
                "unique": [],
                "conflicts": [],
                "caveats": [],
                "error": f"Failed to parse stdin: {e}",
            }, out_path)
            sys.exit(0)
    else:
        # File mode
        for path in positional:
            try:
                raw_ledgers.append(load_ledger(path))
            except Exception as e:
                emit({
                    "total_sources": 0,
                    "total_facts": 0,
                    "corroborated": [],
                    "unique": [],
                    "conflicts": [],
                    "caveats": [],
                    "error": f"Failed to load {path}: {e}",
                }, out_path)
                sys.exit(0)

    # Parse ledgers into Fact objects
    all_facts = []
    source_urls = set()
    for raw in raw_ledgers:
        source_meta, facts_raw = parse_ledger_raw(raw)
        url = source_meta.get("url", "")
        if url:
            source_urls.add(url)
        for fdict in facts_raw:
            all_facts.append(Fact(fdict, source_meta))

    if not all_facts:
        emit({
            "total_sources": len(source_urls),
            "total_facts": 0,
            "corroborated": [],
            "unique": [],
            "conflicts": [],
            "caveats": ["No facts found in any ledger."],
            "error": None,
        }, out_path)
        sys.exit(0)

    # Cluster
    clusters = cluster_facts(all_facts)

    # Classify
    corroborated, unique, conflicts = classify_clusters(clusters, all_facts)

    # Build caveats
    caveats = [
        "Clustering is limited to numbers, statistics, dates, names, places, "
        "and quotes; free-text claim corroboration is not automated.",
        "Facts from the same source are never clustered together — "
        "corroboration requires distinct source URLs.",
    ]
    if conflicts:
        caveats.append(
            f"{len(conflicts)} conflict(s) detected — review variants for "
            "source-quality and recency differences."
        )

    output = {
        "total_sources": len(source_urls),
        "total_facts": len(all_facts),
        "corroborated": corroborated,
        "unique": unique,
        "conflicts": conflicts,
        "caveats": caveats,
        "error": None,
    }

    emit(output, out_path)


if __name__ == "__main__":
    main()