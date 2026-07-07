#![deny(clippy::all)]

//! Full-text search over a bundled corpus with [tantivy].
//!
//! This crate demonstrates the **stateful native library** pattern: the index,
//! its reader, and the query parser are built once and stored in a process-wide
//! `OnceLock` static, then shared by every request for the life of the server.
//! Individual `#[napi]` exports are thin stateless views over that shared
//! state — the opposite of the pure-function crates elsewhere in this app.
//!
//! The corpus (10k synthetic docs, see `corpus/generate.mjs`) is embedded into
//! the addon binary via `include_str!`, so the deployed artifact is fully
//! self-contained: no data files to locate at runtime.

use std::sync::OnceLock;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, Value, STORED, TEXT};
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, TantivyDocument};

/// The corpus travels inside the compiled addon. ~2 MB of JSONL: one
/// `{"title": ..., "body": ...}` per line, generated deterministically by
/// `corpus/generate.mjs` (synthetic, MIT — no third-party data).
const CORPUS_JSONL: &str = include_str!("../corpus/corpus.jsonl");

const MAX_QUERY_LEN: usize = 200;
const MAX_LIMIT: u32 = 50;
const DEFAULT_LIMIT: u32 = 10;
const SNIPPET_MAX_CHARS: usize = 160;
const WRITER_HEAP_BYTES: usize = 50_000_000;
const TITLE_BOOST: f32 = 2.0;

#[derive(Deserialize)]
struct CorpusDoc {
    title: String,
    body: String,
}

/// Everything the hot path needs, built exactly once per process.
struct SearchService {
    // `IndexReader` keeps the underlying (in-RAM) index alive and hands out
    // point-in-time `Searcher`s; `_index` is retained so the service owns the
    // full stack it was built from.
    _index: Index,
    reader: IndexReader,
    query_parser: QueryParser,
    title: Field,
    body: Field,
    doc_count: u32,
    build_ms: f64,
}

/// The one process-wide instance. `OnceLock::get_or_init` guarantees a single
/// build even under concurrent first requests: one caller builds, the rest
/// block until it finishes, and every later call is a cheap pointer read.
/// Build failure is cached as an error string so a broken corpus fails every
/// call loudly instead of retrying a doomed build per request.
static SERVICE: OnceLock<std::result::Result<SearchService, String>> = OnceLock::new();

fn build_service() -> std::result::Result<SearchService, String> {
    let started = Instant::now();

    let mut schema_builder = Schema::builder();
    // TEXT = tokenized + indexed with positions; STORED so hits can return the
    // original strings for display and snippet generation.
    let title = schema_builder.add_text_field("title", TEXT | STORED);
    let body = schema_builder.add_text_field("body", TEXT | STORED);
    let schema = schema_builder.build();

    // In-RAM index: ideal for an embedded, rebuilt-per-process corpus — no
    // filesystem paths to manage, which also keeps serverless happy.
    let index = Index::create_in_ram(schema);

    let mut writer = index
        .writer::<TantivyDocument>(WRITER_HEAP_BYTES)
        .map_err(|e| format!("tantivy writer: {e}"))?;

    let mut doc_count: u32 = 0;
    for (line_no, line) in CORPUS_JSONL.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let parsed: CorpusDoc = serde_json::from_str(line)
            .map_err(|e| format!("corpus line {}: invalid JSON: {e}", line_no + 1))?;
        writer
            .add_document(doc!(title => parsed.title, body => parsed.body))
            .map_err(|e| format!("corpus line {}: add_document: {e}", line_no + 1))?;
        doc_count += 1;
    }
    if doc_count == 0 {
        return Err("corpus is empty — regenerate corpus/corpus.jsonl".to_string());
    }

    writer.commit().map_err(|e| format!("tantivy commit: {e}"))?;

    let reader = index.reader().map_err(|e| format!("tantivy reader: {e}"))?;
    reader.reload().map_err(|e| format!("tantivy reload: {e}"))?;

    let mut query_parser = QueryParser::for_index(&index, vec![title, body]);
    query_parser.set_field_boost(title, TITLE_BOOST);

    Ok(SearchService {
        _index: index,
        reader,
        query_parser,
        title,
        body,
        doc_count,
        build_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn service() -> Result<&'static SearchService> {
    SERVICE
        .get_or_init(build_service)
        .as_ref()
        .map_err(|message| Error::from_reason(message.clone()))
}

/// Stats for the shared index (also proof it exists).
#[napi(object)]
pub struct IndexStats {
    /// Number of documents in the index.
    pub doc_count: u32,
    /// Wall-clock milliseconds the one-time index build took (parse + index +
    /// commit). Paid once per process, by whichever request arrives first.
    pub build_ms: f64,
}

/// One ranked search result.
#[napi(object)]
pub struct SearchHit {
    /// The document title, verbatim from the corpus.
    pub title: String,
    /// tantivy's BM25 relevance score (higher = better match).
    pub score: f64,
    /// Body snippet as HTML: matched terms wrapped in `<b>`, all other text
    /// HTML-escaped by tantivy's snippet generator, so it is safe to render.
    pub snippet: String,
}

/// Builds the shared index if this process hasn't yet, and returns its stats.
///
/// `async` because the one-time build is real work (~hundreds of ms): napi
/// runs it on the worker pool so the Node event loop never blocks, even on the
/// unlucky first request. Every subsequent call returns the cached stats.
#[napi]
pub async fn ensure_index() -> Result<IndexStats> {
    let svc = service()?;
    Ok(IndexStats {
        doc_count: svc.doc_count,
        build_ms: svc.build_ms,
    })
}

/// Ranked full-text search over the corpus; returns up to `limit` hits
/// (1–50, 0 means the default of 10).
///
/// Deliberately **synchronous**: once the index is warm a query is tens of
/// microseconds, far below the cost of a thread-pool hop, so this stays on
/// the main thread (the async-by-convention rule cuts both ways). Call
/// `ensureIndex()` first — if the index isn't built yet, this builds it
/// synchronously and the event loop pays for it.
#[napi]
pub fn search(query: String, limit: u32) -> Result<Vec<SearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(Error::from_reason("query must not be empty"));
    }
    if trimmed.len() > MAX_QUERY_LEN {
        return Err(Error::from_reason(format!(
            "query too long: {} chars (max {MAX_QUERY_LEN})",
            trimmed.len()
        )));
    }
    let limit = if limit == 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    };

    let svc = service()?;
    let searcher = svc.reader.searcher();

    // Lenient parse: user-typed queries with stray syntax ("AND (", quotes)
    // still search instead of erroring.
    let (parsed_query, _errors) = svc.query_parser.parse_query_lenient(trimmed);

    let collector = TopDocs::with_limit(limit as usize).order_by_score();
    let top_docs = searcher
        .search(&parsed_query, &collector)
        .map_err(|e| Error::from_reason(format!("search failed: {e}")))?;

    let mut snippet_generator = SnippetGenerator::create(&searcher, &*parsed_query, svc.body)
        .map_err(|e| Error::from_reason(format!("snippet generator: {e}")))?;
    snippet_generator.set_max_num_chars(SNIPPET_MAX_CHARS);

    let mut hits = Vec::with_capacity(top_docs.len());
    for (score, doc_address) in top_docs {
        let doc: TantivyDocument = searcher
            .doc(doc_address)
            .map_err(|e| Error::from_reason(format!("doc fetch: {e}")))?;

        let title = doc
            .get_first(svc.title)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        // Snippet with <b>-highlighted matches; if the match was title-only
        // the body snippet is empty, so fall back to the (escaped) body head.
        let snippet = snippet_generator.snippet_from_doc(&doc);
        let snippet_html = if snippet.fragment().is_empty() {
            let body_text = doc
                .get_first(svc.body)
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            html_escape(truncate_chars(body_text, SNIPPET_MAX_CHARS))
        } else {
            snippet.to_html()
        };

        hits.push(SearchHit {
            title,
            score: f64::from(score),
            snippet: snippet_html,
        });
    }
    Ok(hits)
}

fn truncate_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((byte_index, _)) => &text[..byte_index],
        None => text,
    }
}

fn html_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}
