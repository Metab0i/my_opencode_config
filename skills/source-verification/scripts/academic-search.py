#!/usr/bin/env python3
"""academic-search.py — Multi-engine academic paper search with deduplication.

Queries PubMed, arXiv, Semantic Scholar, DOAJ, and Europe PMC in parallel,
normalizes results to a unified schema, deduplicates by DOI (with title
fallback), and optionally fetches open-access full text (JATS XML via Europe
PMC).

Usage:
    python3 academic-search.py "quantum entanglement"
    python3 academic-search.py "CRISPR gene editing" --engines pubmed,epmc --limit 10
    python3 academic-search.py "transformer architecture" --full-text --limit 3
    python3 academic-search.py "covid mRNA vaccine" --engines arxiv,s2,doaj --limit 5

Options:
    QUERY               Search query (positional argument)
    --engines LIST      Comma-separated engine names (default: pubmed,arxiv,s2,doaj,epmc)
    --limit N           Results per engine (default: 5, max: 20)
    --full-text         Fetch OA full text where available (JATS XML via Europe PMC)

Engines: pubmed, arxiv, s2 (Semantic Scholar), doaj, epmc (Europe PMC)
"""

import json
import os
import re
import sys
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

MAX_LIMIT = 20
DEFAULT_LIMIT = 5
ALL_ENGINES = ["pubmed", "arxiv", "s2", "doaj", "epmc"]
USER_AGENT = "Mozilla/5.0 (opencode-source-agent; academic-search)"
S2_API_KEY = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "")

FULL_TEXT_MAX_CHARS = 50000


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url, headers=None, timeout=30):
    """Perform an HTTP GET request. Returns (status_code, body_bytes, error_msg)."""
    if headers is None:
        headers = {}
    headers.setdefault("User-Agent", USER_AGENT)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read(), None
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, body, f"HTTP {e.code}: {e.reason}"
    except Exception as e:
        return 0, b"", str(e)


def http_get_with_retry(url, headers=None, timeout=30, max_retries=3):
    """HTTP GET with exponential backoff for 429/5xx responses."""
    if headers is None:
        headers = {}
    delay = 1.0
    status, body, err = 0, b"", "No attempts made"
    for _ in range(max_retries):
        status, body, err = http_get(url, headers, timeout)
        if status == 200:
            return status, body, None
        if status in (429,) or (500 <= status < 600):
            time.sleep(delay)
            delay *= 2
            continue
        return status, body, err
    return status, body, err or f"Failed after {max_retries} retries (last status {status})"


# ---------------------------------------------------------------------------
# Normalised result helper
# ---------------------------------------------------------------------------

def make_result(title, authors, year, abstract, doi, url, source, source_id,
                is_open_access=False, full_text_url=None, full_text=None,
                journal=None, keywords=None, matched_engines=None, pmc_id=None,
                extra=None):
    r = {
        "title": title or "",
        "authors": authors or [],
        "year": year,
        "abstract": abstract,
        "doi": doi.lower() if doi else None,
        "url": url,
        "source": source,
        "source_id": str(source_id) if source_id else None,
        "is_open_access": is_open_access,
        "full_text_url": full_text_url,
        "full_text": full_text,
        "journal": journal,
        "keywords": keywords or [],
        "matched_engines": matched_engines or [source],
        "pmc_id": pmc_id,
    }
    if extra:
        r.update(extra)
    return r


# ---------------------------------------------------------------------------
# Engine: PubMed (ESearch + EFetch, 2 calls)
# ---------------------------------------------------------------------------

EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PUBMED_TOOL = "opencode_source_agent"
PUBMED_EMAIL = "noreply@opencode.ai"


def search_pubmed(query, limit):
    results = []
    # Step 1: ESearch to get PMIDs
    esearch_url = (
        f"{EUTILS_BASE}/esearch.fcgi?db=pubmed"
        f"&term={urllib.parse.quote(query)}"
        f"&retmax={limit}&retmode=json&sort=relevance"
        f"&tool={PUBMED_TOOL}&email={PUBMED_EMAIL}"
    )
    status, body, err = http_get(esearch_url)
    if err or status != 200:
        return results, err or f"ESearch returned HTTP {status}"

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as e:
        return results, f"ESearch JSON parse error: {e}"

    idlist = data.get("esearchresult", {}).get("idlist", [])
    if not idlist:
        return results, None

    # Step 2: EFetch to get full records (XML)
    pmids_str = ",".join(idlist)
    efetch_url = (
        f"{EUTILS_BASE}/efetch.fcgi?db=pubmed"
        f"&id={pmids_str}&retmode=xml&rettype=abstract"
        f"&tool={PUBMED_TOOL}&email={PUBMED_EMAIL}"
    )
    status, body, err = http_get(efetch_url)
    if err or status != 200:
        return results, err or f"EFetch returned HTTP {status}"

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        return results, f"EFetch XML parse error: {e}"

    for article in root.findall(".//PubmedArticle"):
        medline = article.find(".//MedlineCitation")
        art = article.find(".//Article")
        if art is None:
            continue

        # Title
        title_el = art.find(".//ArticleTitle")
        title = "".join(title_el.itertext()).strip() if title_el is not None else ""

        # Abstract (may have multiple AbstractText elements)
        abstract_parts = []
        for at in art.findall(".//Abstract/AbstractText"):
            label = at.get("Label", "")
            text = "".join(at.itertext()).strip()
            if label:
                abstract_parts.append(f"{label}: {text}")
            else:
                abstract_parts.append(text)
        abstract = " ".join(abstract_parts) if abstract_parts else None

        # Authors
        authors = []
        for au in art.findall(".//AuthorList/Author"):
            last = au.findtext("LastName", "")
            fore = au.findtext("ForeName", "")
            collective = au.findtext("CollectiveName", "")
            if last or fore:
                authors.append(f"{fore} {last}".strip())
            elif collective:
                authors.append(collective)

        # Year
        year = None
        year_el = art.find(".//Journal/JournalIssue/PubDate/Year")
        if year_el is not None and year_el.text:
            year = int(year_el.text)
        else:
            medline_date = article.findtext(".//PubMedPubDate[@PubStatus='pubmed']/Year")
            if medline_date:
                try:
                    year = int(medline_date)
                except ValueError:
                    pass

        # DOI
        doi = None
        for el in article.findall(".//ArticleId"):
            if el.get("IdType") == "doi":
                doi = (el.text or "").strip()
                break
        if not doi:
            for el in art.findall(".//ELocationID"):
                if el.get("EIdType") == "doi":
                    doi = (el.text or "").strip()
                    break

        # PMC ID
        pmc_id = None
        for el in article.findall(".//ArticleId"):
            if el.get("IdType") == "pmc":
                pmc_id = (el.text or "").strip()
                break

        # PMID
        pmid = article.findtext(".//PMID")

        # Journal
        journal = None
        journal_el = art.find(".//Journal/Title")
        if journal_el is not None and journal_el.text:
            journal = journal_el.text.strip()

        # OA determination: if in PMC, treat as OA
        is_oa = pmc_id is not None

        # URL
        url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else None
        if doi:
            url = f"https://doi.org/{doi}"

        full_text_url = None
        if pmc_id:
            full_text_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmc_id}/"

        results.append(make_result(
            title=title, authors=authors, year=year, abstract=abstract,
            doi=doi, url=url, source="pubmed", source_id=pmid,
            is_open_access=is_oa, full_text_url=full_text_url,
            journal=journal, pmc_id=pmc_id,
        ))

    return results, None


# ---------------------------------------------------------------------------
# Engine: arXiv (1 call, Atom XML)
# ---------------------------------------------------------------------------

ARXIV_BASE = "https://export.arxiv.org/api/query"
ATOM_NS = "http://www.w3.org/2005/Atom"
ARXIV_NS = "http://arxiv.org/schemas/atom"


def search_arxiv(query, limit):
    search_query = f'all:"{query}"'
    url = (
        f"{ARXIV_BASE}?search_query={urllib.parse.quote(search_query)}"
        f"&start=0&max_results={limit}&sortBy=relevance"
    )
    status, body, err = http_get(url)
    if err or status != 200:
        return [], err or f"arXiv returned HTTP {status}"

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        return [], f"arXiv XML parse error: {e}"

    results = []
    for entry in root.findall(f"{{{ATOM_NS}}}entry"):
        title_el = entry.find(f"{{{ATOM_NS}}}title")
        title = (title_el.text or "").strip().replace("\n", " ") if title_el is not None else ""
        title = re.sub(r"\s+", " ", title)

        # Authors
        authors = []
        for au in entry.findall(f"{{{ATOM_NS}}}author"):
            name_el = au.find(f"{{{ATOM_NS}}}name")
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())

        # Abstract / summary
        summary_el = entry.find(f"{{{ATOM_NS}}}summary")
        abstract = (summary_el.text or "").strip().replace("\n", " ") if summary_el is not None else None
        if abstract:
            abstract = re.sub(r"\s+", " ", abstract)

        # Published date
        pub_el = entry.find(f"{{{ATOM_NS}}}published")
        year = None
        if pub_el is not None and pub_el.text:
            m = re.match(r"(\d{4})", pub_el.text)
            if m:
                year = int(m.group(1))

        # arXiv ID from <id>
        entry_id = ""
        id_el = entry.find(f"{{{ATOM_NS}}}id")
        if id_el is not None and id_el.text:
            raw_id = id_el.text.strip()
            m = re.search(r"/abs/(.+)$", raw_id)
            entry_id = m.group(1) if m else raw_id

        # DOI
        doi = None
        doi_el = entry.find(f"{{{ARXIV_NS}}}doi")
        if doi_el is not None and doi_el.text:
            doi = doi_el.text.strip()

        # Journal ref
        journal = None
        jr_el = entry.find(f"{{{ARXIV_NS}}}journal_ref")
        if jr_el is not None and jr_el.text:
            journal = jr_el.text.strip()

        # Links: abstract page, PDF, DOI
        abstract_url = None
        pdf_url = None
        for link in entry.findall(f"{{{ATOM_NS}}}link"):
            rel = link.get("rel", "")
            title_attr = link.get("title", "")
            href = link.get("href", "")
            if rel == "alternate" and href:
                abstract_url = href
            elif title_attr == "pdf" and href:
                pdf_url = href

        # Primary category
        primary_el = entry.find(f"{{{ARXIV_NS}}}primary_category")
        primary_cat = primary_el.get("term", "") if primary_el is not None else None

        url = abstract_url or f"https://arxiv.org/abs/{entry_id}"
        full_text_url = pdf_url

        results.append(make_result(
            title=title, authors=authors, year=year, abstract=abstract,
            doi=doi, url=url, source="arxiv", source_id=entry_id,
            is_open_access=True, full_text_url=full_text_url,
            journal=journal, keywords=[primary_cat] if primary_cat else [],
            extra={"arxiv_id": entry_id},
        ))

    return results, None


# ---------------------------------------------------------------------------
# Engine: Semantic Scholar (1 call, JSON)
# ---------------------------------------------------------------------------

S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = "title,authors,abstract,year,externalIds,openAccessPdf,url,isOpenAccess,venue"


def search_s2(query, limit):
    fields_param = S2_FIELDS
    params = {
        "query": query,
        "limit": str(min(limit, 100)),
        "fields": fields_param,
    }
    url = f"{S2_BASE}?{urllib.parse.urlencode(params)}"

    headers = {}
    if S2_API_KEY:
        headers["x-api-key"] = S2_API_KEY

    status, body, err = http_get_with_retry(url, headers=headers, timeout=45)
    if err or status != 200:
        return [], err or f"Semantic Scholar returned HTTP {status}"

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as e:
        return [], f"Semantic Scholar JSON parse error: {e}"

    results = []
    for paper in data.get("data", []):
        title = paper.get("title", "")
        authors = [a.get("name", "") for a in paper.get("authors", []) if a.get("name")]
        abstract = paper.get("abstract")
        year = paper.get("year")
        if isinstance(year, str) and year.isdigit():
            year = int(year)
        ext_ids = paper.get("externalIds", {}) or {}
        doi = ext_ids.get("DOI")
        arxiv_id = ext_ids.get("ArXiv")
        pmid = ext_ids.get("PubMed")
        s2_id = paper.get("paperId", "")
        url_s2 = paper.get("url", "")
        is_oa = paper.get("isOpenAccess", False)
        oa_pdf = paper.get("openAccessPdf", {}) or {}
        full_text_url = oa_pdf.get("url") if oa_pdf else None
        venue = paper.get("venue")

        url = url_s2 or f"https://www.semanticscholar.org/paper/{s2_id}" if s2_id else None
        if doi:
            url = f"https://doi.org/{doi}"

        results.append(make_result(
            title=title, authors=authors, year=year, abstract=abstract,
            doi=doi, url=url, source="s2", source_id=s2_id,
            is_open_access=bool(is_oa), full_text_url=full_text_url,
            journal=venue, extra={"arxiv_id": arxiv_id, "pmid": pmid},
        ))

    return results, None


# ---------------------------------------------------------------------------
# Engine: DOAJ (1 call, JSON, query in path segment)
# ---------------------------------------------------------------------------

DOAJ_BASE = "https://doaj.org/api/search/articles"


def search_doaj(query, limit):
    encoded_query = urllib.parse.quote(query)
    url = f"{DOAJ_BASE}/{encoded_query}?pageSize={min(limit, 100)}&page=1"
    status, body, err = http_get(url)
    if err or status != 200:
        return [], err or f"DOAJ returned HTTP {status}"

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as e:
        return [], f"DOAJ JSON parse error: {e}"

    results = []
    for item in data.get("results", []):
        bj = item.get("bibjson", {})

        title = bj.get("title", "")

        authors = []
        for au in bj.get("author", []):
            name = au.get("name", "")
            if name:
                authors.append(name)

        abstract = bj.get("abstract")
        if abstract:
            # DOAJ abstracts may contain HTML entities
            abstract = abstract.replace("&#8722;", "-").replace("&amp;", "&")
            abstract = re.sub(r"<[^>]+>", "", abstract)
            abstract = re.sub(r"\s+", " ", abstract).strip()

        # Year
        year = None
        yr_str = bj.get("year", "")
        if yr_str and yr_str.isdigit():
            year = int(yr_str)

        # DOI
        doi = None
        for identifier in bj.get("identifier", []):
            if identifier.get("type", "").lower() == "doi":
                doi = identifier.get("id", "").strip()
                break

        # Full text URL
        full_text_url = None
        for link in bj.get("link", []):
            if link.get("type", "").lower() == "fulltext":
                full_text_url = link.get("url", "")
                break

        # Journal
        journal = bj.get("journal", {}).get("title")

        # Keywords
        keywords = bj.get("keywords", [])

        # Source ID
        source_id = item.get("id", "")

        # URL: prefer DOI, then full text URL
        url = None
        if doi:
            url = f"https://doi.org/{doi}"
        elif full_text_url:
            url = full_text_url
        else:
            url = f"https://doaj.org/article/{source_id}" if source_id else None

        results.append(make_result(
            title=title, authors=authors, year=year, abstract=abstract,
            doi=doi, url=url, source="doaj", source_id=source_id,
            is_open_access=True, full_text_url=full_text_url,
            journal=journal, keywords=keywords,
        ))

    return results, None


# ---------------------------------------------------------------------------
# Engine: Europe PMC (1 search call, core resultType; +N full-text calls)
# ---------------------------------------------------------------------------

EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
EPMC_FT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"


def search_epmc(query, limit, want_full_text=False):
    params = {
        "query": query,
        "format": "json",
        "pageSize": str(min(limit, 1000)),
        "resultType": "core",
    }
    url = f"{EPMC_BASE}?{urllib.parse.urlencode(params)}"
    status, body, err = http_get(url, timeout=45)
    if err or status != 200:
        return [], err or f"Europe PMC returned HTTP {status}"

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as e:
        return [], f"Europe PMC JSON parse error: {e}"

    results = []
    for result in data.get("resultList", {}).get("result", []):
        title = result.get("title", "")
        author_string = result.get("authorString", "")
        authors = [a.strip() for a in author_string.split(",") if a.strip()]
        # Some EPMC results have structured authorList
        author_list = result.get("authorList", {}).get("author", [])
        if author_list:
            structured = []
            for au in author_list:
                full = au.get("fullName", "")
                if not full:
                    first = au.get("firstName", "")
                    last = au.get("lastName", "")
                    full = f"{first} {last}".strip()
                if full:
                    structured.append(full)
            if structured:
                authors = structured

        abstract = result.get("abstractText")
        if abstract:
            abstract = re.sub(r"<[^>]+>", "", abstract)
            abstract = re.sub(r"\s+", " ", abstract).strip()

        doi = result.get("doi", "")
        doi = doi.strip() if doi else None

        year = None
        py_str = result.get("pubYear", "")
        if py_str and py_str.isdigit():
            year = int(py_str)

        pmid = result.get("pmid", "")
        source = result.get("source", "")
        epmc_id = result.get("id", "")
        source_id = pmid or epmc_id

        journal = result.get("journalTitle", "")
        if not journal:
            ji = result.get("journalInfo", {})
            journal = ji.get("journal", {}).get("title", "")

        is_oa = result.get("isOpenAccess", "N") == "Y"
        in_epmc = result.get("inEPMC", "N") == "Y"
        in_pmc = result.get("inPMC", "N") == "Y"
        has_pdf = result.get("hasPDF", "N") == "Y"

        # Full text URLs from fullTextUrlList
        full_text_url = None
        ftu_list = result.get("fullTextUrlList", {}).get("fullTextUrl", [])
        for ftu in ftu_list:
            doc_style = ftu.get("documentStyle", "")
            availability = ftu.get("availability", "")
            if availability == "Free" and ftu.get("url", ""):
                full_text_url = ftu.get("url", "")
                break
        if not full_text_url and ftu_list:
            for ftu in ftu_list:
                if ftu.get("url", ""):
                    full_text_url = ftu.get("url", "")
                    break

        # PMC ID
        pmc_id = None
        if in_pmc or in_epmc:
            pmc_id = epmc_id if source == "PMC" else None

        # URL
        url = None
        if doi:
            url = f"https://doi.org/{doi}"
        elif full_text_url:
            url = full_text_url
        elif epmc_id and source:
            url = f"https://europepmc.org/article/{source}/{epmc_id}"

        # Keywords (may be list of strings or list of objects with 'name')
        keywords = []
        kwd_list = result.get("keywordList", {}).get("keyword", [])
        for kw in kwd_list:
            if isinstance(kw, dict):
                name = kw.get("name", "")
            elif isinstance(kw, str):
                name = kw
            else:
                name = ""
            if name:
                keywords.append(name)

        result_obj = make_result(
            title=title, authors=authors, year=year, abstract=abstract,
            doi=doi, url=url, source="epmc", source_id=str(source_id) if source_id else epmc_id,
            is_open_access=is_oa, full_text_url=full_text_url,
            journal=journal, keywords=keywords, pmc_id=pmc_id,
            extra={
                "epmc_id": epmc_id,
                "epmc_source": source,
                "in_epmc": in_epmc,
                "in_pmc": in_pmc,
                "pubtype": result.get("pubType", ""),
            },
        )

        # Fetch full text if requested and available
        if want_full_text and (in_epmc or in_pmc):
            if source == "PMC" and epmc_id:
                ft, ft_err = fetch_epmc_full_text(source, epmc_id)
            elif doi:
                ft, ft_err = fetch_full_text_by_doi(doi)
            else:
                ft, ft_err = None, "No PMC ID or DOI for full text lookup"
            if ft and not ft_err:
                result_obj["full_text"] = ft
            elif ft_err:
                result_obj.setdefault("_full_text_error", ft_err)

        results.append(result_obj)

    return results, None


def fetch_epmc_full_text(source, epmc_id):
    """Fetch JATS XML full text from Europe PMC and extract plain text."""
    if source == "PMC" and epmc_id and not epmc_id.startswith("PMC"):
        full_id = f"PMC{epmc_id}"
    else:
        full_id = epmc_id
    ft_url = f"{EPMC_FT_BASE}/{full_id}/fullTextXML"
    status, body, err = http_get(ft_url, timeout=60)
    if err or status != 200:
        return None, err or f"Full text fetch returned HTTP {status}"

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        return None, f"JATS XML parse error: {e}"

    # Extract text from <body> or all <p> elements
    text_parts = []
    for elem in root.iter():
        tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        if tag == "p":
            text = "".join(elem.itertext()).strip()
            if text:
                text_parts.append(text)
        elif tag in ("title", "sec"):
            text = "".join(elem.itertext()).strip()
            if text and len(text) < 200:
                text_parts.append(text)

    if not text_parts:
        # Fallback: extract all text
        full_text = "".join(root.itertext()).strip()
    else:
        full_text = "\n\n".join(text_parts)

    if len(full_text) > FULL_TEXT_MAX_CHARS:
        full_text = full_text[:FULL_TEXT_MAX_CHARS] + "...[truncated]"

    return full_text, None


# ---------------------------------------------------------------------------
# Engine: cross-reference full text by DOI via Europe PMC
# ---------------------------------------------------------------------------

def fetch_full_text_by_doi(doi):
    """Look up a DOI in Europe PMC and fetch JATS full text if available.

    Searches specifically for the PMC-deposited version (SRC:PMC) since the
    fullTextXML endpoint only works with PMC IDs, not MED/PMID records.
    """
    if not doi:
        return None, "No DOI provided"
    query = f'(DOI:"{doi}") AND (SRC:PMC)'
    params = {
        "query": query,
        "format": "json",
        "pageSize": "1",
        "resultType": "lite",
    }
    url = f"{EPMC_BASE}?{urllib.parse.urlencode(params)}"
    status, body, err = http_get(url, timeout=30)
    if err or status != 200:
        return None, err or f"EPMC DOI lookup returned HTTP {status}"

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        return None, "EPMC DOI lookup JSON parse error"

    results = data.get("resultList", {}).get("result", [])
    if not results:
        return None, "No PMC-deposited full text found for this DOI"

    r = results[0]
    source = r.get("source", "")
    epmc_id = r.get("id", "")

    if source != "PMC" or not epmc_id:
        return None, "DOI found but not PMC-deposited"

    return fetch_epmc_full_text(source, epmc_id)


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def normalize_title(title):
    """Normalize title for comparison: lowercase, strip punctuation, collapse whitespace."""
    t = title.lower()
    t = re.sub(r"[^\w\s]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def title_similarity(t1, t2):
    """Jaccard similarity of word sets between two normalized titles."""
    words1 = set(normalize_title(t1).split())
    words2 = set(normalize_title(t2).split())
    if not words1 or not words2:
        return 0.0
    intersection = words1 & words2
    union = words1 | words2
    return len(intersection) / len(union)


def merge_results(group):
    """Merge a group of duplicate results into one."""
    if len(group) == 1:
        return group[0]

    merged = dict(group[0])
    matched = set()
    for r in group:
        matched.update(r.get("matched_engines", []))
    merged["matched_engines"] = sorted(matched)

    # Pick the richest metadata
    for r in group:
        # Longest abstract
        r_abs = r.get("abstract") or ""
        m_abs = merged.get("abstract") or ""
        if len(r_abs) > len(m_abs):
            merged["abstract"] = r["abstract"]
        # Longest author list
        if len(r.get("authors", [])) > len(merged.get("authors", [])):
            merged["authors"] = r["authors"]
        # Prefer OA=true if any engine says so
        if r.get("is_open_access"):
            merged["is_open_access"] = True
        # Prefer full_text_url if not already set
        if r.get("full_text_url") and not merged.get("full_text_url"):
            merged["full_text_url"] = r["full_text_url"]
        # Prefer full_text if not already set
        if r.get("full_text") and not merged.get("full_text"):
            merged["full_text"] = r["full_text"]
        # Prefer DOIs / IDs from primary sources
        if r.get("pmc_id") and not merged.get("pmc_id"):
            merged["pmc_id"] = r["pmc_id"]
        # Year: prefer earliest known
        if r.get("year") and (not merged.get("year") or (isinstance(merged.get("year"), int) and isinstance(r.get("year"), int) and r["year"] < merged["year"])):
            merged["year"] = r["year"]
        # Journal: prefer non-null
        if r.get("journal") and not merged.get("journal"):
            merged["journal"] = r["journal"]
        # Keywords: combine
        for kw in r.get("keywords", []):
            if kw and kw not in merged.get("keywords", []):
                merged.setdefault("keywords", []).append(kw)

    return merged


def deduplicate(results):
    """Deduplicate by DOI (primary) with title-similarity fallback."""
    by_doi = {}
    no_doi = []

    for r in results:
        doi = r.get("doi")
        if doi:
            key = doi.lower()
            by_doi.setdefault(key, []).append(r)
        else:
            no_doi.append(r)

    merged = [merge_group(g) for g in by_doi.values()]

    # Title-based dedup for results without DOI
    deduped_no_doi = []
    for r in no_doi:
        r_title = r.get("title", "")
        if not r_title:
            deduped_no_doi.append(r)
            continue
        found = False
        for existing in deduped_no_doi:
            if title_similarity(r_title, existing.get("title", "")) > 0.85:
                # Merge r into existing
                group = [existing, r]
                merged_result = merge_results(group)
                deduped_no_doi.remove(existing)
                deduped_no_doi.append(merged_result)
                found = True
                break
        if not found:
            deduped_no_doi.append(r)

    # Also check no-DOI results against DOI results by title
    final_deduped = []
    for r in deduped_no_doi:
        r_title = r.get("title", "")
        if not r_title:
            final_deduped.append(r)
            continue
        merged_into = None
        for existing in merged:
            if title_similarity(r_title, existing.get("title", "")) > 0.85:
                group = [existing, r]
                merged_idx = merged.index(existing)
                merged[merged_idx] = merge_results(group)
                merged_into = True
                break
        if not merged_into:
            final_deduped.append(r)

    return merged + final_deduped


merge_group = merge_results  # alias for readability


# ---------------------------------------------------------------------------
# Full text enrichment for non-EPMC results
# ---------------------------------------------------------------------------

def enrich_full_text(results):
    """For OA results without full text, try EPMC JATS lookup.
    Prefers PMC IDs (from PubMed), falls back to DOI lookup.
    """
    for r in results:
        if r.get("full_text"):
            continue
        if not r.get("is_open_access"):
            continue
        # Try PMC ID first if available (e.g. from PubMed)
        pmc_id = r.get("pmc_id")
        if pmc_id:
            pmc_numeric = pmc_id.replace("PMC", "") if pmc_id.startswith("PMC") else pmc_id
            ft, err = fetch_epmc_full_text("PMC", pmc_numeric)
            if ft and not err:
                r["full_text"] = ft
                continue
            elif err and "404" not in str(err):
                r["_full_text_error"] = err
        # Fall back to DOI lookup in EPMC
        doi = r.get("doi")
        if not doi:
            continue
        ft, err = fetch_full_text_by_doi(doi)
        if ft and not err:
            r["full_text"] = ft
        elif err:
            r["_full_text_error"] = err
        time.sleep(0.3)  # polite rate limiting


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv):
    query = None
    engines = ALL_ENGINES
    limit = DEFAULT_LIMIT
    want_full_text = False

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--engines" and i + 1 < len(argv):
            engines = [e.strip().lower() for e in argv[i + 1].split(",")]
            i += 2
        elif arg == "--limit" and i + 1 < len(argv):
            try:
                limit = int(argv[i + 1])
            except ValueError:
                limit = DEFAULT_LIMIT
            limit = max(1, min(limit, MAX_LIMIT))
            i += 2
        elif arg == "--full-text":
            want_full_text = True
            i += 1
        elif not arg.startswith("--") and query is None:
            query = arg
            i += 1
        else:
            i += 1

    return query, engines, limit, want_full_text


def main():
    query, engines, limit, want_full_text = parse_args(sys.argv[1:])

    if not query:
        print(json.dumps({
            "error": "No query provided. Usage: academic-search.py 'QUERY' [--engines LIST] [--limit N] [--full-text]",
        }, indent=2))
        sys.exit(0)

    # Validate engines
    invalid = [e for e in engines if e not in ALL_ENGINES]
    if invalid:
        print(json.dumps({
            "error": f"Unknown engine(s): {', '.join(invalid)}",
            "available_engines": ALL_ENGINES,
        }, indent=2))
        sys.exit(0)

    # Threaded search
    results_thread = {}
    errors_thread = {}
    threads = {}

    def run_engine(engine_name):
        try:
            if engine_name == "pubmed":
                res, err = search_pubmed(query, limit)
            elif engine_name == "arxiv":
                res, err = search_arxiv(query, limit)
            elif engine_name == "s2":
                res, err = search_s2(query, limit)
            elif engine_name == "doaj":
                res, err = search_doaj(query, limit)
            elif engine_name == "epmc":
                res, err = search_epmc(query, limit, want_full_text)
            else:
                res, err = [], f"Unknown engine: {engine_name}"
        except Exception as e:
            res, err = [], f"Engine error: {e}"
        results_thread[engine_name] = res
        errors_thread[engine_name] = err

    for engine in engines:
        t = threading.Thread(target=run_engine, args=(engine,))
        threads[engine] = t
        t.start()

    for t in threads.values():
        t.join(timeout=120)

    # Collect results
    all_results = []
    engine_stats = {}
    for engine in engines:
        res = results_thread.get(engine, [])
        err = errors_thread.get(engine)
        all_results.extend(res)
        engine_stats[engine] = {
            "found": len(res),
            "errors": err,
        }

    # Deduplicate
    deduped = deduplicate(all_results)

    # Full text enrichment for non-EPMC results
    if want_full_text:
        enrich_full_text(deduped)

    # Build caveats
    caveats = []
    if "arxiv" in engines:
        caveats.append("arXiv rate limit: 1 request per 3 seconds enforced (single call satisfies this).")
    if "s2" in engines:
        s2_err = engine_stats.get("s2", {}).get("errors")
        if s2_err and "429" in str(s2_err):
            caveats.append("Semantic Scholar returned 429; retried with exponential backoff.")
        else:
            caveats.append("Semantic Scholar may return 429 under heavy load; retried with backoff if needed.")
    if want_full_text:
        caveats.append("Full text available only for open-access papers deposited in Europe PMC (JATS XML). PDF-only sources list full_text_url instead.")

    output = {
        "query": query,
        "engines_searched": engines,
        "full_text_mode": want_full_text,
        "total_results": len(deduped),
        "results": deduped,
        "engine_stats": engine_stats,
        "caveats": caveats,
        "error": None,
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()