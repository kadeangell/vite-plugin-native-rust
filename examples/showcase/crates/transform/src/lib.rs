#![deny(clippy::all)]

//! Email-HTML transform: two crates composed in one export.
//!
//! Stage 1 — `lol_html` (Cloudflare's streaming rewriter): a SINGLE pass over
//! the input that rewrites `<a href>` links (UTM tagging) and inlines a fixed
//! CSS class → `style=""` map (the email-client classic). No DOM is ever
//! built — the document streams through selector-matched handlers.
//!
//! Stage 2 — `ammonia`: allowlist sanitization tuned for email content
//! (tables, inline styles, http/https/mailto URLs; scripts, event handlers
//! and `javascript:` URLs are stripped).

use std::cell::Cell;
use std::time::Instant;

use lol_html::html_content::Element;
use lol_html::{element, RewriteStrSettings};
use napi::bindgen_prelude::Result;
use napi_derive::napi;

/// The fixed class → inline-style map applied when `inlineStyles` is on.
///
/// Kept deliberately small and mirrored verbatim by the JS baseline
/// (`app/transform-baseline.server.ts`) so both implementations do identical
/// work. Order matters: styles are emitted in class-attribute order.
const CLASS_STYLE_MAP: &[(&str, &str)] = &[
    (
        "btn",
        "display:inline-block;padding:12px 24px;background-color:#1a73e8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600",
    ),
    (
        "heading",
        "margin:0 0 12px;font-size:24px;line-height:1.3;font-weight:700;color:#111827",
    ),
    (
        "body-text",
        "margin:0 0 16px;font-size:16px;line-height:1.6;color:#374151",
    ),
    ("muted", "color:#6b7280;font-size:13px"),
    (
        "card",
        "background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px",
    ),
    ("divider", "border:none;border-top:1px solid #e5e7eb;margin:24px 0"),
    (
        "footer",
        "font-size:12px;line-height:1.5;color:#9ca3af;text-align:center",
    ),
];

/// Options for [`transform_html`]. `#[napi(object)]` maps this to a plain JS
/// object literal (fields arrive camelCased: `utmSource`, `inlineStyles`,
/// `sanitize`).
#[napi(object)]
pub struct TransformOpts {
    /// Value for the appended `utm_source` query param. An empty string
    /// disables link rewriting.
    pub utm_source: String,
    /// Apply the fixed class → inline-style map and drop `class` attributes.
    pub inline_styles: bool,
    /// Run the ammonia sanitization stage.
    pub sanitize: bool,
}

/// Result of [`transform_html`]: the transformed HTML plus per-stage timings
/// and a diff-ish summary of what changed.
#[napi(object)]
pub struct TransformResult {
    /// The transformed (and, if requested, sanitized) HTML.
    pub html: String,
    /// Milliseconds spent in the single lol_html streaming pass
    /// (link rewriting + class inlining).
    pub rewrite_ms: f64,
    /// Milliseconds spent in ammonia sanitization (0 when `sanitize` is off).
    pub sanitize_ms: f64,
    /// Input size in bytes (UTF-8).
    pub bytes_in: u32,
    /// Output size in bytes (UTF-8).
    pub bytes_out: u32,
    /// `<a href>` links that had UTM params appended.
    pub links_rewritten: u32,
    /// Class names that were mapped to inline styles.
    pub classes_inlined: u32,
    /// Dangerous elements (script/style/iframe/object/embed) removed by
    /// sanitization. Counted by tag rather than by total element diff:
    /// ammonia's html5ever parser normalizes the tree (e.g. inserts missing
    /// `<tbody>`), so a raw before/after element count would lie.
    pub elements_removed: u32,
}

/// Percent-encode a query-string value (RFC 3986 unreserved set passes).
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Append `utm_source` / `utm_medium` to an absolute http(s) URL, preserving
/// any fragment. Returns `None` when the URL should be left alone (relative,
/// `mailto:`, already UTM-tagged, ...).
fn append_utm(href: &str, utm_source: &str) -> Option<String> {
    let trimmed = href.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if lower.contains("utm_source=") {
        return None;
    }
    let (base, fragment) = match trimmed.split_once('#') {
        Some((base, fragment)) => (base, Some(fragment)),
        None => (trimmed, None),
    };
    let separator = if base.contains('?') { '&' } else { '?' };
    let mut rewritten = format!(
        "{base}{separator}utm_source={}&utm_medium=email",
        encode_query_value(utm_source)
    );
    if let Some(fragment) = fragment {
        rewritten.push('#');
        rewritten.push_str(fragment);
    }
    Some(rewritten)
}

/// Map every class on the element through [`CLASS_STYLE_MAP`], merge with any
/// existing `style` attribute (author styles win — appended last), and drop
/// the `class` attribute. Returns how many classes were inlined.
fn inline_classes(el: &mut Element) -> std::result::Result<u32, lol_html::errors::AttributeNameError>
{
    let Some(class_attr) = el.get_attribute("class") else {
        return Ok(0);
    };
    let inlined: Vec<&str> = class_attr
        .split_whitespace()
        .filter_map(|class| {
            CLASS_STYLE_MAP
                .iter()
                .find(|(name, _)| *name == class)
                .map(|(_, css)| *css)
        })
        .collect();
    let count = u32::try_from(inlined.len()).unwrap_or(u32::MAX);
    if !inlined.is_empty() {
        let mut style = inlined.join(";");
        if let Some(existing) = el.get_attribute("style") {
            style.push(';');
            style.push_str(&existing);
        }
        el.set_attribute("style", &style)?;
    }
    el.remove_attribute("class");
    Ok(count)
}

/// Email-appropriate ammonia allowlist: default tags plus a few legacy email
/// ones; presentational attributes and `style` allowed everywhere (required —
/// stage 1 just inlined styles); only http/https/mailto URLs survive.
/// Scripts, `on*` handlers and `javascript:` URLs never make it through.
fn sanitize_email_html(html: &str) -> String {
    ammonia::Builder::default()
        .add_tags(["center", "font"])
        .add_generic_attributes([
            "style",
            "align",
            "valign",
            "width",
            "height",
            "border",
            "bgcolor",
            "cellpadding",
            "cellspacing",
        ])
        .add_tag_attributes("font", ["color", "face", "size"])
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        // Skip ammonia's default rel="noopener noreferrer" injection so the
        // output stays byte-comparable with the JS baseline.
        .link_rel(None)
        .clean(html)
        .to_string()
}

/// Tags whose removal we attribute to sanitization in the diff summary.
const DANGEROUS_TAGS: &[&str] = &["script", "style", "iframe", "object", "embed"];

/// Count dangerous elements with a minimal counting-only lol_html pass.
fn count_dangerous_elements(
    html: &str,
) -> std::result::Result<u32, lol_html::errors::RewritingError> {
    let count = Cell::new(0u32);
    let mut settings = RewriteStrSettings::new();
    for tag in DANGEROUS_TAGS {
        let count = &count;
        settings = settings.append_element_content_handler(element!(*tag, move |_el| {
            count.set(count.get().saturating_add(1));
            Ok(())
        }));
    }
    lol_html::rewrite_str(html, settings)?;
    Ok(count.get())
}

/// Transform untrusted email HTML: UTM-tag links + inline classes in one
/// lol_html streaming pass, then sanitize with ammonia.
///
/// `async` per this repo's convention: the whole transform runs on napi's
/// worker pool, so a large document never blocks the Node event loop.
#[napi]
pub async fn transform_html(html: String, opts: TransformOpts) -> Result<TransformResult> {
    let bytes_in = u32::try_from(html.len()).map_err(|_| {
        napi::Error::from_reason("transformHtml: input larger than u32::MAX bytes")
    })?;

    let links_rewritten = Cell::new(0u32);
    let classes_inlined = Cell::new(0u32);
    let dangerous_in = Cell::new(0u32);

    let mut settings = RewriteStrSettings::new();
    for tag in DANGEROUS_TAGS {
        let dangerous_in = &dangerous_in;
        settings = settings.append_element_content_handler(element!(*tag, move |_el| {
            dangerous_in.set(dangerous_in.get().saturating_add(1));
            Ok(())
        }));
    }
    if !opts.utm_source.is_empty() {
        let utm_source = opts.utm_source.clone();
        let links_rewritten = &links_rewritten;
        settings = settings.append_element_content_handler(element!("a[href]", move |el| {
            let href = el.get_attribute("href").unwrap_or_default();
            if let Some(rewritten) = append_utm(&href, &utm_source) {
                el.set_attribute("href", &rewritten)?;
                links_rewritten.set(links_rewritten.get().saturating_add(1));
            }
            Ok(())
        }));
    }
    if opts.inline_styles {
        settings = settings.append_element_content_handler(element!("[class]", |el| {
            let inlined = inline_classes(el)?;
            classes_inlined.set(classes_inlined.get().saturating_add(inlined));
            Ok(())
        }));
    }

    let rewrite_started = Instant::now();
    let rewritten = lol_html::rewrite_str(&html, settings)
        .map_err(|err| napi::Error::from_reason(format!("lol_html rewrite failed: {err}")))?;
    let rewrite_ms = rewrite_started.elapsed().as_secs_f64() * 1000.0;

    let (output, sanitize_ms, elements_removed) = if opts.sanitize {
        let sanitize_started = Instant::now();
        let sanitized = sanitize_email_html(&rewritten);
        let sanitize_ms = sanitize_started.elapsed().as_secs_f64() * 1000.0;
        let dangerous_out = count_dangerous_elements(&sanitized).map_err(|err| {
            napi::Error::from_reason(format!("lol_html element count failed: {err}"))
        })?;
        let removed = dangerous_in.get().saturating_sub(dangerous_out);
        (sanitized, sanitize_ms, removed)
    } else {
        (rewritten, 0.0, 0)
    };

    let bytes_out = u32::try_from(output.len()).unwrap_or(u32::MAX);
    Ok(TransformResult {
        html: output,
        rewrite_ms,
        sanitize_ms,
        bytes_in,
        bytes_out,
        links_rewritten: links_rewritten.get(),
        classes_inlined: classes_inlined.get(),
        elements_removed,
    })
}
