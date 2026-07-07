// JS baseline for the search demo: minisearch over the IDENTICAL corpus the
// tantivy crate embeds, with matching ranking knobs (title boosted 2x, OR
// semantics) and comparable per-hit work (a highlighted snippet), so the
// benchmark compares engines, not feature sets.
//
// Mirrors the Rust crate's stateful shape: the index is built once per
// process, lazily, and shared by every request.
import MiniSearch from "minisearch";

import { CORPUS, type CorpusDoc } from "./search-corpus.server";

export interface MiniIndexStats {
  docCount: number;
  buildMs: number;
}

export interface MiniHit {
  title: string;
  score: number;
  /** Body snippet as HTML: matched terms in `<b>`, everything else escaped. */
  snippet: string;
}

const MAX_QUERY_LEN = 200;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SNIPPET_MAX_CHARS = 160;
const TITLE_BOOST = 2;

interface MiniService {
  mini: MiniSearch<CorpusDoc>;
  stats: MiniIndexStats;
}

let service: MiniService | null = null;

/** Builds the minisearch index if this process hasn't yet; returns its stats. */
export function ensureMiniIndex(): MiniIndexStats {
  if (service === null) {
    const started = performance.now();
    const mini = new MiniSearch<CorpusDoc>({
      fields: ["title", "body"],
      storeFields: ["title", "body"],
    });
    mini.addAll([...CORPUS]);
    const stats: MiniIndexStats = {
      docCount: CORPUS.length,
      buildMs: Number((performance.now() - started).toFixed(1)),
    };
    service = { mini, stats };
  }
  return service.stats;
}

/** Ranked search over the corpus; returns up to `limit` hits with snippets. */
export function searchMini(query: string, limit: number = DEFAULT_LIMIT): MiniHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("query must not be empty");
  }
  if (trimmed.length > MAX_QUERY_LEN) {
    throw new Error(`query too long: ${trimmed.length} chars (max ${MAX_QUERY_LEN})`);
  }
  const cappedLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);

  ensureMiniIndex();
  if (service === null) {
    throw new Error("minisearch index unavailable");
  }
  const results = service.mini.search(trimmed, {
    boost: { title: TITLE_BOOST },
  });

  return results.slice(0, cappedLimit).map((result) => ({
    title: result.title as string,
    score: Number(result.score.toFixed(4)),
    snippet: makeSnippet(result.body as string, result.terms),
  }));
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Comparable work to tantivy's SnippetGenerator, kept deliberately simple:
// window the body around the first matched term and bold every match.
function makeSnippet(body: string, terms: readonly string[]): string {
  const lower = body.toLowerCase();
  let windowStart = 0;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0) {
      windowStart = Math.max(0, at - 60);
      break;
    }
  }
  let snippet = escapeHtml(body.slice(windowStart, windowStart + SNIPPET_MAX_CHARS));
  for (const term of terms) {
    // Terms are alphanumeric tokens, so matching on escaped text is safe.
    snippet = snippet.replace(
      new RegExp(`\\b(${escapeRegExp(term)})`, "gi"),
      "<b>$1</b>",
    );
  }
  return snippet;
}
