#!/usr/bin/env python3
"""source-picker.py — Domain-aware source selection from the JSON catalogue.

Given a domain name, returns the Tier 1/2/3 sources for that domain as JSON.
Sources flagged with academic_search_engine=true can be queried directly by
academic-search.py; the agent should use webfetch for all others.

Usage:
    python3 source-picker.py --domain "Science & Academia"
    python3 source-picker.py --domain medicine
    python3 source-picker.py --list-domains
"""

import json
import os
import sys

CATALOGUE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "source_catalogue.json",
)


def load_catalogue():
    with open(CATALOGUE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def find_domain(catalogue, query):
    """Case-insensitive substring match against domain keys."""
    domains = catalogue["domains"]
    query_lower = query.lower().strip()
    # Exact match first
    for key in domains:
        if key.lower() == query_lower:
            return key
    # Substring match
    matches = [key for key in domains if query_lower in key.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        return matches[0]  # first match
    return None


def main():
    argv = sys.argv[1:]

    if "--list-domains" in argv:
        catalogue = load_catalogue()
        output = {
            "domains": list(catalogue["domains"].keys()),
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return

    domain_query = None
    for i, arg in enumerate(argv):
        if arg == "--domain" and i + 1 < len(argv):
            domain_query = argv[i + 1]
            break

    if not domain_query:
        print(json.dumps({"error": "Usage: source-picker.py --domain 'DOMAIN' or --list-domains"}, indent=2))
        sys.exit(0)

    try:
        catalogue = load_catalogue()
    except Exception as e:
        print(json.dumps({"error": f"Failed to load catalogue: {e}"}, indent=2))
        sys.exit(0)

    domain_key = find_domain(catalogue, domain_query)
    if not domain_key:
        print(json.dumps({
            "error": f"No domain matching '{domain_query}'",
            "available_domains": list(catalogue["domains"].keys()),
            "suggestion": "Use --list-domains to see all available domains.",
        }, indent=2, ensure_ascii=False))
        sys.exit(0)

    domain_data = catalogue["domains"][domain_key]

    output = {
        "domain": domain_key,
        "tier1": domain_data.get("tier1", []),
        "tier2": domain_data.get("tier2", []),
        "tier3": domain_data.get("tier3", []),
        "selection_rules": catalogue.get("selection_rules", []),
        "discovery_protocol": catalogue.get("new_source_discovery_protocol", {}).get("steps", []),
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()