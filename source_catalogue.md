# Source Catalogue

Shared reference for domain-aware source selection. When answering a question, classify its domain and select sources from the appropriate tier below.

## Selection Rules

1. **Tier 1 first**: Always start with Tier 1 (primary) sources for the identified domain.
2. **Tier 2 for cross-reference**: Verify Tier 1 claims against 2-3 Tier 2 sources.
3. **Tier 3 for supplementary**: Use only when Tier 1/2 are insufficient or for additional context.
4. **Wikipedia is never Tier 1**: Wikipedia is supplementary only and must always be scored via the wiki-quality-assessment skill.
5. **Paywalled sources**: Use abstracts/summaries for verification but do not treat paywalled content as primary evidence.
6. **No domain match**: If the question doesn't fit a listed domain, use the General domain. If even that is insufficient, discover new sources, use them, then prompt the user to consider adding them to this catalogue.

---

## Science & Academia

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Semantic Scholar | https://www.semanticscholar.org | Free API | 214M+ papers, AI-powered relevance, free REST API |
| PubMed | https://pubmed.ncbi.nlm.nih.gov | Free API (E-utilities) | 40M+ biomedical citations, NLM-curated, MeSH taxonomy |
| arXiv | https://arxiv.org | Free API | Preprints (not peer-reviewed) for physics, math, CS, stats |
| DOAJ | https://doaj.org | Free API | Curated open-access journals, vetted for legitimacy |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured knowledge, 122M+ entities, CC0 |
| Wolfram Alpha | https://www.wolframalpha.com | Free web | Computational verification of quantitative claims |
| NASA Data Portal | https://data.nasa.gov | Free API (CKAN) | Earth/space science, climate data |
| Scholarpedia | http://www.scholarpedia.org | Free web | Expert-authored, peer-reviewed, narrow coverage |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| JSTOR | https://www.jstor.org | Paywall (6 free/mo) | Rigorous journal selection, limited free access |
| Stanford Encyclopedia of Philosophy | https://plato.stanford.edu | Free web | Expert-authored, Stanford/NEH/NSF backed |
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment; never primary |

---

## Medicine & Health

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| PubMed | https://pubmed.ncbi.nlm.nih.gov | Free API (E-utilities) | 40M+ biomedical citations, NLM-curated |
| Cochrane Library | https://www.cochranelibrary.com | Abstracts free | Gold standard systematic reviews, paywalled full text |
| MedlinePlus | https://medlineplus.gov | Free web + API | NLM/NIH service, evidence-based, no ads |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| WHO Data | https://www.who.int/data | Free web | UN health statistics, member-state reporting |
| Mayo Clinic | https://www.mayoclinic.org | Free web | Physician-reviewed, commercial institution |
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured medical knowledge with source links |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |
| Snopes (health claims) | https://www.snopes.com | Free web | IFCN-certified fact-checking |

---

## Law & Legal

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Cornell LII | https://www.law.cornell.edu | Free web | U.S. Constitution, Code, CFR, SCOTUS opinions |
| SCOTUSblog | https://www.scotusblog.com | Free web + RSS | Authoritative Supreme Court tracking |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured legal knowledge |
| Internet Archive | https://archive.org | Free API | Historical legal documents, web history |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |

---

## Statistics, Economics & Data

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| World Bank Open Data | https://data.worldbank.org | Free API | 189 countries, development indicators |
| OECD Data | https://data.oecd.org | Free API | 38 member countries, rigorous methodology |
| U.S. Census Bureau | https://www.census.gov | Free API | Official U.S. demographic/economic statistics |
| Bureau of Labor Statistics | https://www.bls.gov | Free API | Employment, inflation, wages, productivity |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured economic data |
| Wolfram Alpha | https://www.wolframalpha.com | Free web | Computational verification |
| WHO Data | https://www.who.int/data | Free web | Global health statistics |
| NASA Data Portal | https://data.nasa.gov | Free API (CKAN) | Climate and environmental data |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |
| Reuters (economic news) | https://www.reuters.com | Partially paywalled | IFCN signatory, wire-service neutrality |

---

## News & Current Events

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Reuters | https://www.reuters.com | Partially paywalled | IFCN signatory, wire-service neutrality |
| Associated Press | https://apnews.com | Partially paywalled | Primary wire service, rigorous standards |

### Tier 2 (Cross-Reference / Fact-Checking)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Snopes | https://www.snopes.com | Free web | IFCN-certified, founded 1994, transparent methodology |
| FactCheck.org | https://www.factcheck.org | Free web + RSS | Annenberg/UPenn, nonpartisan, includes SciCheck |
| PolitiFact | https://www.politifact.com | Free web | Pulitzer-winning, Poynter Institute, IFCN-certified |
| Full Fact (UK) | https://fullfact.org | Free web | IFCN-certified UK charity |
| Africa Check | https://africacheck.org | Free web | IFCN-certified, pan-African coverage |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment; may lag on breaking news |
| Internet Archive | https://archive.org | Free API | Verify historical web content claims |

---

## Philosophy & Humanities

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Stanford Encyclopedia of Philosophy | https://plato.stanford.edu | Free web | Expert-authored, peer-reviewed, dynamically updated |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured philosophical knowledge |
| Scholarpedia | http://www.scholarpedia.org | Free web | Expert-authored (limited philosophy coverage) |
| JSTOR | https://www.jstor.org | Paywall (6 free/mo) | Humanities journal archive |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |

---

## Technology & Web Development

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| MDN Web Docs | https://developer.mozilla.org | Free web + GitHub | Definitive web platform reference, W3C-aligned |
| NIST | https://www.nist.gov | Free web + APIs | Standards, cybersecurity frameworks, technical constants |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| arXiv (CS) | https://arxiv.org | Free API | Cutting-edge CS research (preprints, not peer-reviewed) |
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured tech knowledge |
| Semantic Scholar | https://www.semanticscholar.org | Free API | CS paper search and relevance |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |

---

## General / Unclassified

Use when the question doesn't clearly fit a specific domain above.

### Tier 1 (Primary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikidata | https://www.wikidata.org | Free SPARQL/API | Structured knowledge across all domains |
| Wolfram Alpha | https://www.wolframalpha.com | Free web | Computational knowledge engine |
| Semantic Scholar | https://www.semanticscholar.org | Free API | Broad academic coverage |

### Tier 2 (Cross-Reference)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Scholarpedia | http://www.scholarpedia.org | Free web | Expert-authored, peer-reviewed |
| Snopes | https://www.snopes.com | Free web | Fact-checking for popular claims |
| FactCheck.org | https://www.factcheck.org | Free web + RSS | Nonpartisan verification |
| Reuters | https://www.reuters.com | Partially paywalled | Wire-service reporting |

### Tier 3 (Supplementary)
| Source | URL | Access | Notes |
|--------|-----|--------|-------|
| Wikipedia | https://en.wikipedia.org | Free web | Must run quality assessment |
| Internet Archive | https://archive.org | Free API | Historical verification |
| DBpedia | https://www.dbpedia.org | Free SPARQL | Structured Wikipedia extraction |

---

## New Source Discovery Protocol

When no suitable sources exist in this catalogue for a given domain:

1. Use websearch to find authoritative sources in the domain
2. Evaluate candidates against these criteria:
   - Institutional backing or peer-review process
   - Editorial standards and corrections policy
   - Author expertise and accountability
   - Citation practices
   - Independence from commercial/political bias
3. Use the discovered sources to answer the question
4. After answering, prompt the user: "I discovered [source name] ([URL]) which appears to be a strong [domain] source with [reasons]. Would you like me to add it to the source catalogue for future use?"
