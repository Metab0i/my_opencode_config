#!/usr/bin/env python3
"""
Wikipedia Article Quality Assessment Script (v2)

Assesses the reliability of a Wikipedia article and the quality of its references.
Uses a weighted ensemble scoring model with 5 components:
  - ML quality (Lift Wing/ORES expected value)
  - Human grade (WikiProject Talk page assessment)
  - Reference quality (Parsoid HTML parsing: count, types, density, DOI/ISBN)
  - Community engagement (protection, watchers, pageviews, editor diversity)
  - Maintenance (citation gaps, citation-needed, dispute templates)

Outputs a single JSON object to stdout. Always exits 0 — errors are emitted as
JSON with an "error" field so the calling agent can parse them gracefully.

Dependencies: Python 3 stdlib only (urllib, json, sys, os, re, html.parser, datetime)

Usage:
    python3 wiki-article-assessment.py "Article Title"

Optional environment variables:
    WIKILIFT_TOKEN — Bearer token for Lift Wing API (raises rate limits).
                     If absent, anonymous access is used (50,000 req/hour).
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

USER_AGENT = (
    "wiki-article-assessment/2.0 "
    "(opencode; https://github.com/anomalyco/opencode)"
)

API_BASE = "https://en.wikipedia.org/w/api.php"
PARSOID_URL = "https://en.wikipedia.org/api/rest_v1/page/html/{title}"
LIFTWING_URL = (
    "https://api.wikimedia.org/service/lw/inference/v1/models/"
    "enwiki-articlequality:predict"
)
ORES_URLS = [
    "https://ores.wikimedia.org/v3/scores/enwiki?models=articlequality&revids={revid}",
    "https://ores.wikimedia.org/v3/scores/enwiki?models=wp10&revids={revid}",
]

CITATION_GAP_CATEGORIES = {
    "All articles with unsourced statements",
    "Articles with unsourced statements",
    "Articles needing additional references",
    "Articles lacking sources",
    "Articles with dead external links",
    "Articles with incomplete citations",
    "Articles lacking reliable references",
}

DISPUTE_TEMPLATES = {
    "npov": "NPOV",
    "disputed": "Disputed",
    "controversial": "Controversial",
    "peacock": "Peacock",
    "weasel": "Weasel",
    "advert": "Advert",
    "cooked": "Cooked",
    "fringe": "Fringe",
}

CLEANUP_TEMPLATES = {
    "cleanup": "Cleanup",
    "copy edit": "CopyEdit",
    "wikify": "Wikify",
    "tone": "Tone",
}

# Grade -> numeric value
GRADE_NUMERIC = {
    "FA": 1.0,
    "GA": 0.85,
    "A": 0.75,
    "B": 0.60,
    "C": 0.40,
    "Start": 0.20,
    "Stub": 0.10,
}

GRADE_ORDER = ["FA", "GA", "A", "B", "C", "Start", "Stub"]

DEFAULT_CAVEATS = [
    "ML model assesses structural quality, not content accuracy",
    "Reference type classification is heuristic-based (Parsoid HTML parsing)",
    "Human assessments can be stale — WikiProject grades are manually applied",
    "Pageviews cover last 60 days only",
]


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def make_request(url, method="GET", headers=None, data=None, timeout=30):
    if headers is None:
        headers = {}
    headers["User-Agent"] = USER_AGENT

    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            if not body:
                return None
            # Try JSON first, fall back to raw text
            try:
                return json.loads(body)
            except (json.JSONDecodeError, ValueError):
                return body  # Return raw text (for Parsoid HTML)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} from {url}\n")
        return None
    except urllib.error.URLError as e:
        sys.stderr.write(f"URL error for {url}: {e.reason}\n")
        return None
    except Exception as e:
        sys.stderr.write(f"Unexpected error for {url}: {e}\n")
        return None


def api_get(params_dict, base=API_BASE):
    url = f"{base}?{urllib.parse.urlencode(params_dict)}"
    return make_request(url)


# ---------------------------------------------------------------------------
# Call A: Batched MediaWiki query (revision + info + categories + extlinks + pageviews)
# ---------------------------------------------------------------------------

def fetch_article_data(title):
    params = {
        "action": "query",
        "titles": title,
        "prop": "revisions|info|categories|extlinks|pageviews",
        "rvprop": "ids|timestamp",
        "rvlimit": "1",
        "inprop": "protection|watchers|url",
        "cllimit": "500",
        "ellimit": "500",
        "pvipdays": "60",
        "format": "json",
        "formatversion": "2",
    }
    data = api_get(params)

    # If pageviews caused an API error, retry without pageviews
    if data is None or (isinstance(data, dict) and "error" in data):
        sys.stderr.write("Retrying without pageviews prop...\n")
        params["prop"] = "revisions|info|categories|extlinks"
        params.pop("pvipdays", None)
        data = api_get(params)

    if data is None:
        return None

    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return None

    page = pages[0]

    if page.get("missing"):
        return {"missing": True, "title": title}

    normalized_title = page.get("title", title)

    revisions = page.get("revisions", [])
    rev_id = None
    last_modified = None
    if revisions:
        rev_id = revisions[0].get("revid")
        last_modified = revisions[0].get("timestamp")

    protection_array = page.get("protection", [])
    protection_level = "unprotected"
    if protection_array:
        levels = [p.get("level", "") for p in protection_array if p.get("type") == "edit"]
        if any(l == "sysop" for l in levels):
            protection_level = "fully protected"
        elif any(l in ("autoconfirmed", "extendedconfirmed") for l in levels):
            protection_level = "semi-protected"

    watchers = page.get("watchers")

    canonical_url = page.get("canonicalurl") or page.get("fullurl", "")

    length_bytes = page.get("length", 0)

    categories = page.get("categories", [])
    article_category_names = []
    for cat in categories:
        cat_name = cat.get("title", "")
        if cat_name.startswith("Category:"):
            cat_name = cat_name[len("Category:"):]
        article_category_names.append(cat_name)

    extlinks_raw = page.get("extlinks", [])
    external_links = [el.get("*", "") for el in extlinks_raw]

    # Pageviews
    pageviews_raw = page.get("pageviews", {})
    pageviews_last_60d = 0
    pv_days_with_data = 0
    for date_str, count in pageviews_raw.items():
        if count is not None and count > 0:
            pageviews_last_60d += count
            pv_days_with_data += 1
    avg_daily_views = pageviews_last_60d // max(pv_days_with_data, 1)

    # Days since last edit
    days_since_last_edit = None
    if last_modified:
        try:
            # Parse ISO 8601 timestamp: "2026-06-30T21:50:35Z"
            dt = datetime.strptime(last_modified, "%Y-%m-%dT%H:%M:%SZ")
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            days_since_last_edit = (now - dt).days
        except Exception:
            pass

    return {
        "missing": False,
        "title": normalized_title,
        "rev_id": rev_id,
        "last_modified": last_modified,
        "days_since_last_edit": days_since_last_edit,
        "protection": protection_level,
        "watchers": watchers,
        "canonical_url": canonical_url,
        "length_bytes": length_bytes,
        "article_categories": article_category_names,
        "external_links": external_links,
        "pageviews_last_60d": pageviews_last_60d,
        "avg_daily_views": avg_daily_views,
    }


# ---------------------------------------------------------------------------
# Call B: Talk page categories (human grade)
# ---------------------------------------------------------------------------

def fetch_human_grade(title):
    talk_title = f"Talk:{title}"
    params = {
        "action": "query",
        "titles": talk_title,
        "prop": "categories",
        "cllimit": "500",
        "format": "json",
        "formatversion": "2",
    }
    data = api_get(params)
    if data is None:
        return None, False

    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return None, False

    page = pages[0]
    if page.get("missing"):
        return None, False

    categories = page.get("categories", [])
    cat_names = []
    for cat in categories:
        cat_name = cat.get("title", "")
        if cat_name.startswith("Category:"):
            cat_name = cat_name[len("Category:"):]
        cat_names.append(cat_name)

    # Extract WikiProject grades using strict X-Class pattern only
    # Collect all grades found
    found_grades = []
    for cat_name in cat_names:
        for grade in GRADE_ORDER:
            if f"{grade}-Class" in cat_name:
                found_grades.append(grade)
                break

    # Build grades_by_wikiproject (best effort — extract project from category)
    grades_by_wikiproject = []
    for cat_name in cat_names:
        for grade in GRADE_ORDER:
            if f"{grade}-Class" in cat_name:
                # Try to extract WikiProject name: e.g. "B-Class computing articles"
                # Strip the "{Grade}-Class " prefix and " articles" suffix
                proj_name = cat_name.replace(f"{grade}-Class ", "").replace(" articles", "")
                proj_name = proj_name.replace(" biography", "Biography").replace(" computing", "Computing")
                grades_by_wikiproject.append({
                    "project": proj_name if proj_name else "Unknown",
                    "grade": grade,
                })
                break

    # Check for exclusion patterns (delisted/former featured, delisted good)
    # "former featured articles" → FA was revoked, don't count FA
    # "delisted good articles" → GA was revoked, don't count GA
    cat_names_lower = [c.lower() for c in cat_names]
    former_featured = any("former" in c and "featured" in c for c in cat_names_lower)
    delisted_ga = any("delisted" in c and "good" in c for c in cat_names_lower)
    removed_featured = any("removed" in c and "featured" in c for c in cat_names_lower)

    grades_to_remove = set()
    if former_featured or removed_featured:
        grades_to_remove.add("FA")
    if delisted_ga:
        grades_to_remove.add("GA")

    if grades_to_remove:
        found_grades = [g for g in found_grades if g not in grades_to_remove]

    # Also clean grades_by_wikiproject
    if grades_to_remove:
        grades_by_wikiproject = [
            g for g in grades_by_wikiproject if g["grade"] not in grades_to_remove
        ]

    # Determine highest grade
    highest = None
    for grade in GRADE_ORDER:
        if grade in found_grades:
            highest = grade
            break

    # Check disagreement
    unique_grades = set(found_grades)
    disagreement = len(unique_grades) > 1

    return {
        "highest": highest,
        "grades_by_wikiproject": grades_by_wikiproject,
        "disagreement": disagreement,
    }, True


# ---------------------------------------------------------------------------
# Call C: ML quality prediction (Lift Wing -> ORES fallback)
# ---------------------------------------------------------------------------

def fetch_ml_prediction(rev_id):
    token = os.environ.get("WIKILIFT_TOKEN")

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body = json.dumps({"rev_id": rev_id, "lang": "en"}).encode("utf-8")

    result = make_request(LIFTWING_URL, method="POST", headers=headers, data=body, timeout=30)

    if result is not None and isinstance(result, dict):
        prediction = None
        probabilities = None

        enwiki = result.get("enwiki")
        if enwiki:
            scores = enwiki.get("scores", {})
            rev_scores = scores.get(str(rev_id), {})
            articlequality = rev_scores.get("articlequality", {})
            score = articlequality.get("score", {})
            prediction = score.get("prediction")
            probabilities = score.get("probability")

        if prediction is not None:
            if isinstance(prediction, dict):
                prediction = prediction.get("prediction", prediction)
            # Normalize grade string
            if isinstance(prediction, str):
                for valid_grade in GRADE_ORDER:
                    if prediction.lower() == valid_grade.lower():
                        prediction = valid_grade
                        break
                if prediction not in GRADE_NUMERIC:
                    sys.stderr.write(f"Unrecognized ML grade: '{prediction}'\n")
                    return None, None
            return prediction, probabilities

    # Fall back to ORES
    sys.stderr.write("Lift Wing failed, trying ORES...\n")
    for ores_url_template in ORES_URLS:
        ores_url = ores_url_template.format(revid=rev_id)
        ores_result = make_request(ores_url, timeout=30)
        if ores_result is None:
            continue

        try:
            enwiki = ores_result.get("enwiki", {})
            scores = enwiki.get("scores", {})
            rev_scores = scores.get(str(rev_id), {})
            model_data = rev_scores.get("articlequality", {}) or rev_scores.get("wp10", {})
            score = model_data.get("score", {})
            prediction = score.get("prediction")
            probabilities = score.get("probability")

            if prediction is not None:
                if isinstance(prediction, dict):
                    prediction = prediction.get("prediction", prediction)
                if isinstance(prediction, str):
                    for valid_grade in GRADE_ORDER:
                        if prediction.lower() == valid_grade.lower():
                            prediction = valid_grade
                            break
                    if prediction not in GRADE_NUMERIC:
                        continue
                return prediction, probabilities
        except Exception as e:
            sys.stderr.write(f"ORES parse error: {e}\n")
            continue

    return None, None


# ---------------------------------------------------------------------------
# Call D: Editor diversity + edit frequency
# ---------------------------------------------------------------------------

def fetch_editor_data(title):
    params = {
        "action": "query",
        "titles": title,
        "prop": "revisions",
        "rvprop": "user|timestamp",
        "rvlimit": "500",
        "format": "json",
        "formatversion": "2",
    }
    data = api_get(params)
    if data is None:
        return {"unique_editors": 0, "edits_last_90d": 0}

    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return {"unique_editors": 0, "edits_last_90d": 0}

    page = pages[0]
    if page.get("missing"):
        return {"unique_editors": 0, "edits_last_90d": 0}

    revisions = page.get("revisions", [])
    if not revisions:
        return {"unique_editors": 0, "edits_last_90d": 0}

    users = set()
    edits_last_90d = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    for rev in revisions:
        user = rev.get("user")
        if user:
            users.add(user)
        timestamp = rev.get("timestamp")
        if timestamp:
            try:
                dt = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
                days_ago = (now - dt).days
                if days_ago <= 90:
                    edits_last_90d += 1
            except Exception:
                pass

    return {
        "unique_editors": len(users),
        "edits_last_90d": edits_last_90d,
    }


# ---------------------------------------------------------------------------
# Call E: Parsoid HTML fetch + reference parser
# ---------------------------------------------------------------------------

def fetch_parsoid_html(title):
    encoded_title = urllib.parse.quote(title.replace(" ", "_"), safe="")
    url = PARSOID_URL.format(title=encoded_title)
    return make_request(url, timeout=30)


class RefHTMLParser(HTMLParser):
    """Parse Parsoid-rendered HTML to extract references and classify them."""

    def __init__(self):
        super().__init__()
        self.references = []
        self.in_ref = False
        self.current_ref_id = None
        self.current_ref_content = []
        self.ref_depth = 0

        # Footnote tracking
        self.in_footnote = False
        self.footnote_count = 0

        # Template detection
        self.dispute_templates_found = set()
        self.cleanup_templates_found = set()

        # Cite backlink count (named ref reuses)
        self.reuse_count = 0

        # Citation needed
        self.citation_needed_count = 0

    def handle_starttag(self, tag, attrs):
        attrs_dict = {}
        for k, v in attrs:
            attrs_dict[k] = v if v is not None else ""

        # Track reference list items by about="#cite_note-*"
        if tag == "li":
            about = attrs_dict.get("about", "")
            if "cite_note" in about and about.startswith("#"):
                if self.in_ref:
                    # Nested <li> inside a reference (sub-list in ref block)
                    self.ref_depth += 1
                else:
                    self.in_ref = True
                    self.current_ref_id = about[1:]  # Remove "#"
                    self.current_ref_content = []
                    self.ref_depth = 1
            elif self.in_ref:
                self.ref_depth += 1

        if self.in_ref:
            # Look for external links (DOI, URLs)
            if tag == "a":
                href = attrs_dict.get("href", "")
                rel = attrs_dict.get("rel", "")
                cls = attrs_dict.get("class", "")

                if "doi.org" in href:
                    self.current_ref_content.append("HAS_DOI")
                elif rel == "mw:ExtLink" or "external" in cls:
                    if href.startswith("http"):
                        self.current_ref_content.append("URL:" + href[:200])
                elif rel == "mw:WikiLink":
                    if "Special:BookSources" in href:
                        self.current_ref_content.append("HAS_ISBN")
                    elif "/Template:" in href:
                        # Extract template name
                        parts = href.split("/Template:")
                        template_name = parts[-1] if len(parts) > 1 else ""
                        self.current_ref_content.append("TEMPLATE:" + template_name)

            # Track cite backlinks (named ref reuses)
            if tag == "a" and attrs_dict.get("rel", "") == "mw:referencedBy":
                self.reuse_count += 1

        # Detect ambox templates (dispute/cleanup) outside of references
        if not self.in_ref:
            cls = attrs_dict.get("class", "")
            if "ambox" in cls:
                cls_lower = cls.lower()
                for key, label in DISPUTE_TEMPLATES.items():
                    if key in cls_lower:
                        self.dispute_templates_found.add(label)
                for key, label in CLEANUP_TEMPLATES.items():
                    if key in cls_lower:
                        self.cleanup_templates_found.add(label)

    def handle_endtag(self, tag):
        if self.in_ref and tag == "li":
            self.ref_depth -= 1
            if self.ref_depth <= 0:
                self.in_ref = False
                content_str = " ".join(self.current_ref_content)
                self.references.append({
                    "id": self.current_ref_id,
                    "content": content_str,
                })
                self.current_ref_id = None
                self.current_ref_content = []
                self.ref_depth = 0

    def handle_data(self, data):
        if self.in_ref:
            stripped = data.strip()
            if stripped:
                self.current_ref_content.append(stripped)
                # Check for citation needed text
                if "citation needed" in stripped.lower():
                    self.citation_needed_count += 1

        # Also check for citation needed text outside refs (in body text)
        if not self.in_ref:
            if "citation needed" in data.lower():
                self.citation_needed_count += 1
            # Check for "cn" template indicator (less reliable, but Parsoid
            # renders {{cn}} as visible text "citation needed" in most cases)


def parse_parsoid_references(html_text):
    """Parse Parsoid HTML to extract and classify references."""
    if not html_text or not isinstance(html_text, str):
        return _empty_references(), _empty_maintenance()

    # Pre-scan for dispute/cleanup templates in raw HTML
    # (ambox classes are more reliably caught via regex on raw HTML)
    dispute_templates = []
    cleanup_templates = []

    html_lower = html_text.lower()
    for key, label in DISPUTE_TEMPLATES.items():
        # Look for ambox classes like "ambox-npov", "ambox-disputed"
        if f"ambox-{key}" in html_lower or f"ambox_{key}" in html_lower:
            if label not in dispute_templates:
                dispute_templates.append(label)

    for key, label in CLEANUP_TEMPLATES.items():
        if f"ambox-{key}" in html_lower or f"ambox_{key}" in html_lower:
            if label not in cleanup_templates:
                cleanup_templates.append(label)

    # Also check data-mw for template targets
    # Pattern: "wt":"NPOV" or "href":"./Template:NPOV"
    template_targets = re.findall(r'"(?:wt|href)"\s*:\s*"[^"]*(?:Template:)?(NPOV|disputed|controversial|peacock|weasel|advert|cleanup|copy.?edit|wikify|tone)"', html_text, re.IGNORECASE)
    for t in template_targets:
        t_lower = t.lower()
        if t_lower in DISPUTE_TEMPLATES:
            label = DISPUTE_TEMPLATES[t_lower]
            if label not in dispute_templates:
                dispute_templates.append(label)
        elif t_lower in CLEANUP_TEMPLATES:
            label = CLEANUP_TEMPLATES.get(t_lower, t)
            if label not in cleanup_templates:
                cleanup_templates.append(label)

    # Count "citation needed" from raw HTML (more reliable than HTMLParser for this)
    # In Parsoid HTML, {{cn}} / {{citation needed}} renders as a <span> with
    # title="This claim needs references to reliable sources" or similar
    cn_spans = re.findall(r'class="[^"]*(?:citation-needed|cn-need|needref)[^"]*"', html_text, re.IGNORECASE)
    cn_text = len(re.findall(r'[Cc]itation needed', html_text))
    # Take the larger of the two (some articles use different markup)
    citation_needed_count = max(len(cn_spans), cn_text, 0)

    # Parse references with HTMLParser for count and reuse count
    parser = RefHTMLParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception as e:
        sys.stderr.write(f"HTMLParser error: {e}\n")

    total_count = len(parser.references)
    reuse_count = parser.reuse_count

    # Extract <cite> blocks from raw HTML for reference classification
    # In Parsoid, <cite> elements contain the actual citation content with DOI/ISBN/URLs
    # Class: "citation journal cs1" = journal, "citation book cs1" = book, etc.
    cite_pattern = re.compile(
        r'<cite\b[^>]*class="citation\s+(\w+)[^"]*"[^>]*>(.*?)</cite>',
        re.DOTALL | re.IGNORECASE,
    )
    cite_blocks = cite_pattern.findall(html_text)

    # Also look for reference content in <span class="mw-reference-text"> blocks
    # (Parsoid wraps ref content in these, but <cite> is more common for templated refs)
    ref_text_pattern = re.compile(
        r'<span[^>]*class="mw-reference-text[^"]*"[^>]*>(.*?)</span>',
        re.DOTALL | re.IGNORECASE,
    )
    ref_text_blocks = ref_text_pattern.findall(html_text)

    # Use <cite> blocks if found, otherwise fall back to mw-reference-text blocks
    # Each cite block has (cite_type, content) — cite_type is "journal", "book", etc.
    ref_types = {"book": 0, "journal": 0, "news": 0, "web": 0, "other": 0}
    refs_with_doi = 0
    refs_with_isbn = 0
    refs_with_urls = 0

    if cite_blocks:
        for cite_type_raw, cite_content in cite_blocks:
            cite_type = cite_type_raw.lower().strip()
            has_doi = "doi.org" in cite_content
            has_isbn = "Special:BookSources" in cite_content
            has_url = bool(re.search(r'href="https?://', cite_content))

            if has_doi:
                refs_with_doi += 1
            if has_isbn:
                refs_with_isbn += 1
            if has_url:
                refs_with_urls += 1

            if cite_type == "journal":
                ref_types["journal"] += 1
            elif cite_type == "book":
                ref_types["book"] += 1
            elif cite_type in ("news", "newspaper", "magazine"):
                ref_types["news"] += 1
            elif cite_type == "web":
                ref_types["web"] += 1
            else:
                ref_types["other"] += 1
    else:
        # Fall back to mw-reference-text blocks or HTMLParser refs
        blocks_to_scan = ref_text_blocks if ref_text_blocks else [r["content"] for r in parser.references]
        for content in blocks_to_scan:
            has_doi = "doi.org" in content or "HAS_DOI" in content
            has_isbn = "Special:BookSources" in content or "HAS_ISBN" in content
            has_url = "URL:" in content or bool(re.search(r'https?://', content))

            if has_doi:
                ref_types["journal"] += 1
                refs_with_doi += 1
            elif has_isbn:
                ref_types["book"] += 1
                refs_with_isbn += 1
            elif has_url:
                if re.search(r"(newspaper|news|reuters|bbc|cnn|\bap\b|associated press)", content, re.IGNORECASE):
                    ref_types["news"] += 1
                else:
                    ref_types["web"] += 1
                refs_with_urls += 1
            else:
                ref_types["other"] += 1

            if has_url:
                refs_with_urls += 1

    # Detect footnote groups (<ref group="note">) by checking for group indicators
    # In Parsoid HTML, footnotes appear as separate list items
    # Check raw HTML for group="note" or data-mw containing group="note"
    footnote_count = len(re.findall(r'group="note"', html_text, re.IGNORECASE))
    # Also check for common footnote group names
    footnote_count += len(re.findall(r'group="(footnote|fn|nb|lower|upper)"', html_text, re.IGNORECASE))

    # Build references output
    references = {
        "total_count": total_count,
        "reused_count": reuse_count,
        "footnote_count": footnote_count,
        "with_doi": refs_with_doi,
        "with_isbn": refs_with_isbn,
        "with_urls": refs_with_urls,
        "ref_types": ref_types,
        "citation_needed_count": citation_needed_count,
        "external_links_total": 0,  # Filled by caller
    }

    maintenance = {
        "dispute_templates": dispute_templates,
        "cleanup_templates": cleanup_templates,
        "has_no_references": total_count == 0,
    }

    return references, maintenance


def _empty_references():
    return {
        "total_count": 0,
        "reused_count": 0,
        "footnote_count": 0,
        "with_doi": 0,
        "with_isbn": 0,
        "with_urls": 0,
        "ref_types": {"book": 0, "journal": 0, "news": 0, "web": 0, "other": 0},
        "citation_needed_count": 0,
        "external_links_total": 0,
    }


def _empty_maintenance():
    return {
        "dispute_templates": [],
        "cleanup_templates": [],
        "has_no_references": False,
    }


# ---------------------------------------------------------------------------
# Citation gap detection (from article categories)
# ---------------------------------------------------------------------------

def detect_citation_gaps(category_names):
    gaps = []
    for cat_name in category_names:
        for gap_cat in CITATION_GAP_CATEGORIES:
            if gap_cat.lower() in cat_name.lower():
                if cat_name not in gaps:
                    gaps.append(cat_name)
                break
    return gaps


# ---------------------------------------------------------------------------
# Scoring: Weighted Ensemble Model
# ---------------------------------------------------------------------------

def compute_ml_quality(ml_grade, ml_probabilities):
    """Component 1: ML quality (0.0-1.0) — expected value of grade distribution."""
    if ml_grade and ml_probabilities:
        ml_ev = 0.0
        for grade, value in GRADE_NUMERIC.items():
            prob = ml_probabilities.get(grade, 0.0)
            ml_ev += value * prob
        return ml_ev
    elif ml_grade:
        return GRADE_NUMERIC.get(ml_grade, 0.4)
    return None  # Signal unavailable


def compute_human_grade_score(human_grade_data):
    """Component 2: Human grade (0.0-1.0)."""
    if not human_grade_data:
        return None

    highest = human_grade_data.get("highest")
    if highest is None:
        return None

    score = GRADE_NUMERIC.get(highest, 0.4)

    # Penalize disagreement
    if human_grade_data.get("disagreement"):
        score -= 0.05

    return max(0.0, min(1.0, score))


def compute_reference_quality(ref_data, length_bytes):
    """Component 3: Reference quality (0.0-1.0)."""
    total_refs = ref_data.get("total_count", 0)
    ref_types = ref_data.get("ref_types", {})
    with_doi = ref_data.get("with_doi", 0)
    with_isbn = ref_data.get("with_isbn", 0)
    with_urls = ref_data.get("with_urls", 0)
    cn_count = ref_data.get("citation_needed_count", 0)
    footnote_count = ref_data.get("footnote_count", 0)

    score = 0.5  # Neutral start

    # --- Reference density (refs per 1000 bytes) ---
    if length_bytes > 0 and total_refs > 0:
        ref_density = total_refs / (length_bytes / 1000)
        if ref_density > 1.5:
            score += 0.15
        elif ref_density > 0.75:
            score += 0.10
        elif ref_density > 0.25:
            score += 0.00
        else:
            score -= 0.15
    elif total_refs == 0:
        score -= 0.25  # No references at all

    # --- Type quality (academic vs web) ---
    if total_refs > 0:
        academic_refs = ref_types.get("journal", 0) + ref_types.get("book", 0)
        type_quality_ratio = academic_refs / total_refs
        if type_quality_ratio > 0.50:
            score += 0.20
        elif type_quality_ratio > 0.25:
            score += 0.10
        elif type_quality_ratio < 0.25 and ref_types.get("web", 0) > academic_refs:
            score -= 0.05
    else:
        type_quality_ratio = 0.0
    # Store for output
    ref_data["ref_density"] = round(total_refs / max(length_bytes / 1000, 0.001), 4) if length_bytes > 0 else 0.0
    ref_data["type_quality_ratio"] = round(
        (ref_types.get("journal", 0) + ref_types.get("book", 0)) / max(total_refs, 1), 4
    )

    # --- URL coverage ---
    if total_refs > 0:
        url_coverage = with_urls / total_refs
        if url_coverage > 0.60:
            score += 0.10
        elif url_coverage < 0.30:
            score -= 0.05

    # --- Citation needed penalty (normalized by length) ---
    if length_bytes > 0 and cn_count > 0:
        cn_density = cn_count / (length_bytes / 1000)
        score -= min(cn_density * 0.10, 0.25)

    # --- Footnote contamination ---
    if total_refs > 0 and footnote_count > 0:
        footnote_ratio = footnote_count / (total_refs + footnote_count)
        score -= footnote_ratio * 0.05

    return max(0.0, min(1.0, score))


def compute_community_engagement(article_data, editor_data):
    """Component 4: Community engagement (0.0-1.0)."""
    score = 0.0

    # Protection
    protection = article_data.get("protection", "unprotected")
    if protection == "fully protected":
        score += 0.15
    elif protection == "semi-protected":
        score += 0.10

    # Watchers
    watchers = article_data.get("watchers")
    if watchers is not None:
        if watchers > 5000:
            score += 0.15
        elif watchers > 500:
            score += 0.10
        elif watchers > 100:
            score += 0.05

    # Pageviews (last 60d)
    pv = article_data.get("pageviews_last_60d", 0)
    if pv > 100000:
        score += 0.15
    elif pv > 10000:
        score += 0.10
    elif pv > 1000:
        score += 0.05

    # Editor diversity
    unique_editors = editor_data.get("unique_editors", 0)
    if unique_editors > 100:
        score += 0.20
    elif unique_editors > 30:
        score += 0.15
    elif unique_editors > 10:
        score += 0.10
    elif unique_editors > 2:
        score += 0.05

    # Edit frequency (edits in last 90d)
    edits_90d = editor_data.get("edits_last_90d", 0)
    if edits_90d > 20:
        score += 0.15
    elif edits_90d > 5:
        score += 0.10
    elif edits_90d > 0:
        score += 0.05

    return max(0.0, min(1.0, score))


def compute_maintenance(citation_gaps, ref_data, maintenance_data, length_bytes):
    """Component 5: Maintenance (0.0-1.0) — inverted (clean = 1.0)."""
    score = 1.0

    # Citation gap categories
    score -= 0.15 * len(citation_gaps)

    # Citation needed density
    cn_count = ref_data.get("citation_needed_count", 0)
    if length_bytes > 0 and cn_count > 0:
        cn_density = cn_count / (length_bytes / 1000)
        score -= min(cn_density * 0.15, 0.30)

    # Dispute templates
    dispute = maintenance_data.get("dispute_templates", [])
    score -= 0.15 * len(dispute)

    # Cleanup templates
    cleanup = maintenance_data.get("cleanup_templates", [])
    score -= 0.10 * len(cleanup)

    # No references at all
    if maintenance_data.get("has_no_references", False):
        score -= 0.25

    return max(0.0, min(1.0, score))


def compute_composite_score(
    ml_quality, human_grade_score, reference_quality,
    community_engagement, maintenance, human_grade_present
):
    """
    Compute composite score using weighted ensemble.
    Each component is 0.0-1.0, combined with weights.
    When human grade is absent, redistribute its weight.
    """
    components = {
        "ml_quality": ml_quality,
        "human_grade": human_grade_score,
        "reference_quality": reference_quality,
        "community_engagement": community_engagement,
        "maintenance": maintenance,
    }

    # Standard weights
    weights = {
        "ml_quality": 0.25,
        "human_grade": 0.20,
        "reference_quality": 0.30,
        "community_engagement": 0.15,
        "maintenance": 0.10,
    }

    # When human grade is absent, redistribute
    if not human_grade_present or human_grade_score is None:
        weights["ml_quality"] = 0.35
        weights["reference_quality"] = 0.35
        weights["community_engagement"] = 0.20
        weights["maintenance"] = 0.10
        weights["human_grade"] = 0.0

    # When ML quality is also absent, redistribute further
    if ml_quality is None:
        if human_grade_score is not None:
            weights["human_grade"] = 0.35
            weights["reference_quality"] = 0.35 if not human_grade_present else 0.30
            weights["community_engagement"] = 0.20
            weights["maintenance"] = 0.10
            weights["ml_quality"] = 0.0
        else:
            # Both ML and human absent
            weights["reference_quality"] = 0.45
            weights["community_engagement"] = 0.25
            weights["maintenance"] = 0.30
            weights["ml_quality"] = 0.0
            weights["human_grade"] = 0.0

    score = 0.0
    total_weight = 0.0
    component_values = {}
    for key in weights:
        w = weights[key]
        val = components[key]
        if w > 0 and val is not None:
            score += val * w
            total_weight += w
            component_values[key] = round(val, 4)
        elif val is None:
            component_values[key] = None
        else:
            component_values[key] = round(val, 4)

    if total_weight > 0:
        score = score / total_weight  # Normalize by actual weight used

    score = max(0.0, min(1.0, score))

    # Tier assignment
    if score >= 0.80:
        tier = "A"
    elif score >= 0.60:
        tier = "B"
    elif score >= 0.40:
        tier = "C"
    else:
        tier = "D"

    return score, tier, component_values


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        result = {
            "article": {"title": ""},
            "quality_signals": {},
            "references": {},
            "caveats": ["No article title provided"],
            "error": "Usage: python3 wiki-article-assessment.py \"Article Title\"",
        }
        print(json.dumps(result, indent=2))
        return

    title = sys.argv[1].strip()
    if not title:
        result = {
            "article": {"title": ""},
            "quality_signals": {},
            "references": {},
            "caveats": ["Empty article title"],
            "error": "Article title is empty",
        }
        print(json.dumps(result, indent=2))
        return

    caveats = list(DEFAULT_CAVEATS)

    # --- Call A: Article data (with pageviews + timestamp) ---
    article_data = fetch_article_data(title)

    if article_data is None:
        result = {
            "article": {"title": title},
            "quality_signals": {},
            "references": {},
            "caveats": ["MediaWiki API request failed"],
            "error": "Could not fetch article data from MediaWiki API",
        }
        print(json.dumps(result, indent=2))
        return

    if article_data.get("missing"):
        result = {
            "article": {"title": title},
            "quality_signals": {},
            "references": {},
            "caveats": [],
            "error": "Article not found",
        }
        print(json.dumps(result, indent=2))
        return

    # --- Call B: Human grade (talk page) ---
    human_grade_data, talk_page_exists = fetch_human_grade(article_data["title"])

    # --- Call C: ML prediction ---
    ml_grade = None
    ml_probabilities = None
    if article_data.get("rev_id"):
        ml_grade, ml_probabilities = fetch_ml_prediction(article_data["rev_id"])
        if ml_grade is None:
            caveats.append("Lift Wing and ORES both failed — ML signal unavailable")

    # --- Call D: Editor diversity + edit frequency ---
    editor_data = fetch_editor_data(article_data["title"])

    # --- Call E: Parsoid HTML for reference parsing ---
    parsoid_html = fetch_parsoid_html(article_data["title"])
    ref_data, maintenance_data = parse_parsoid_references(parsoid_html)
    ref_data["external_links_total"] = len(article_data.get("external_links", []))

    # --- Citation gap detection ---
    citation_gaps = detect_citation_gaps(article_data.get("article_categories", []))

    # --- Compute ensemble components ---
    ml_quality = compute_ml_quality(ml_grade, ml_probabilities)
    human_grade_score = compute_human_grade_score(human_grade_data)
    reference_quality = compute_reference_quality(ref_data, article_data.get("length_bytes", 0))
    community_engagement = compute_community_engagement(article_data, editor_data)
    maintenance = compute_maintenance(
        citation_gaps, ref_data, maintenance_data, article_data.get("length_bytes", 0)
    )

    # --- Compute composite score ---
    human_grade_present = (
        human_grade_data is not None
        and human_grade_data.get("highest") is not None
    )

    score, tier, component_values = compute_composite_score(
        ml_quality=ml_quality,
        human_grade_score=human_grade_score,
        reference_quality=reference_quality,
        community_engagement=community_engagement,
        maintenance=maintenance,
        human_grade_present=human_grade_present,
    )

    # --- Build ML prediction block ---
    ml_prediction_block = None
    if ml_grade is not None:
        ml_prediction_block = {
            "grade": ml_grade,
            "probability": None,
            "all_probabilities": {},
        }
        if ml_probabilities:
            ml_prediction_block["probability"] = ml_probabilities.get(ml_grade, None)
            ml_prediction_block["all_probabilities"] = {
                g: ml_probabilities.get(g, 0.0)
                for g in GRADE_ORDER
            }

    # --- Build output ---

    result = {
        "article": {
            "title": article_data.get("title", title),
            "url": article_data.get("canonical_url", ""),
            "last_revid": article_data.get("rev_id"),
            "last_modified": article_data.get("last_modified"),
            "days_since_last_edit": article_data.get("days_since_last_edit"),
            "length_bytes": article_data.get("length_bytes", 0),
            "watchers": article_data.get("watchers"),
            "protection": article_data.get("protection", "unprotected"),
            "talk_page_exists": talk_page_exists,
        },
        "quality_signals": {
            "ml_prediction": ml_prediction_block,
            "human_grade": human_grade_data,
            "composite_score": round(score, 4),
            "tier": tier,
            "components": component_values,
        },
        "references": ref_data,
        "community": {
            "pageviews_last_60d": article_data.get("pageviews_last_60d", 0),
            "avg_daily_views": article_data.get("avg_daily_views", 0),
            "unique_editors_500": editor_data.get("unique_editors", 0),
            "edits_last_90d": editor_data.get("edits_last_90d", 0),
            "days_since_last_edit": article_data.get("days_since_last_edit"),
        },
        "maintenance": {
            "citation_gap_categories": citation_gaps,
            "dispute_templates": maintenance_data.get("dispute_templates", []),
            "cleanup_templates": maintenance_data.get("cleanup_templates", []),
            "has_no_references": maintenance_data.get("has_no_references", False),
        },
        "caveats": caveats,
        "error": None,
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()