// JS baseline for the /transform demo: cheerio (parse → modify → serialize)
// + sanitize-html, performing the SAME three transforms as the Rust crate
// (crates/transform): UTM-tag links, inline the fixed class → style map, then
// allowlist-sanitize. The class map, URL rules, and sanitizer allowlist
// mirror the Rust side so both do identical work and the outputs are
// invariant-comparable.

import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";

export interface JsTransformOpts {
  utmSource: string;
  inlineStyles: boolean;
  sanitize: boolean;
}

// Same shape as the Rust crate's TransformResult so the route renders both
// uniformly.
export interface JsTransformResult {
  html: string;
  rewriteMs: number;
  sanitizeMs: number;
  bytesIn: number;
  bytesOut: number;
  linksRewritten: number;
  classesInlined: number;
  /** Dangerous elements (script/style/iframe/object/embed) removed by
   * sanitization — mirrors the Rust crate's tag-based count. */
  elementsRemoved: number;
}

// Mirrors DANGEROUS_TAGS in crates/transform/src/lib.rs.
const DANGEROUS_SELECTOR = "script, style, iframe, object, embed";

// Mirrors CLASS_STYLE_MAP in crates/transform/src/lib.rs — keep in sync.
const CLASS_STYLE_MAP: Readonly<Record<string, string>> = {
  btn: "display:inline-block;padding:12px 24px;background-color:#1a73e8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600",
  heading: "margin:0 0 12px;font-size:24px;line-height:1.3;font-weight:700;color:#111827",
  "body-text": "margin:0 0 16px;font-size:16px;line-height:1.6;color:#374151",
  muted: "color:#6b7280;font-size:13px",
  card: "background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px",
  divider: "border:none;border-top:1px solid #e5e7eb;margin:24px 0",
  footer: "font-size:12px;line-height:1.5;color:#9ca3af;text-align:center",
};

// Mirrors append_utm in the Rust crate: absolute http(s) links only, skip
// already-tagged URLs, preserve fragments.
export function appendUtm(href: string, utmSource: string): string | null {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return null;
  }
  if (lower.includes("utm_source=")) {
    return null;
  }
  const hashIndex = trimmed.indexOf("#");
  const base = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : trimmed.slice(hashIndex);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}utm_source=${encodeURIComponent(utmSource)}&utm_medium=email${fragment}`;
}

// Mirrors the ammonia allowlist in the Rust crate: default-ish safe tags plus
// legacy email ones; presentational attributes and style everywhere; only
// http/https/mailto URLs survive.
const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "center", "font"],
  allowedAttributes: {
    "*": [
      "style",
      "align",
      "valign",
      "width",
      "height",
      "border",
      "bgcolor",
      "cellpadding",
      "cellspacing",
    ],
    a: ["href", "hreflang"],
    img: ["src", "alt"],
    font: ["color", "face", "size"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
};

function loadFragment(html: string): cheerio.CheerioAPI {
  // Third arg `false` = fragment mode: don't wrap in <html><body>.
  return cheerio.load(html, null, false);
}

/**
 * The cheerio + sanitize-html counterpart to the Rust `transformHtml`.
 * Synchronous by nature — this runs ON the event loop, which is itself part
 * of the comparison story.
 */
export function transformHtmlJs(html: string, opts: JsTransformOpts): JsTransformResult {
  const bytesIn = Buffer.byteLength(html);
  let linksRewritten = 0;
  let classesInlined = 0;

  const rewriteStarted = performance.now();
  const $ = loadFragment(html);
  const dangerousIn = $(DANGEROUS_SELECTOR).length;

  if (opts.utmSource !== "") {
    $("a[href]").each((_i, el) => {
      const $el = $(el);
      const rewritten = appendUtm($el.attr("href") ?? "", opts.utmSource);
      if (rewritten !== null) {
        $el.attr("href", rewritten);
        linksRewritten += 1;
      }
    });
  }

  if (opts.inlineStyles) {
    $("[class]").each((_i, el) => {
      const $el = $(el);
      const classes = ($el.attr("class") ?? "").split(/\s+/).filter(Boolean);
      const inlined = classes
        .map((name) => CLASS_STYLE_MAP[name])
        .filter((css): css is string => css !== undefined);
      if (inlined.length > 0) {
        let style = inlined.join(";");
        const existing = $el.attr("style");
        if (existing !== undefined) {
          style = `${style};${existing}`; // author styles win: appended last
        }
        $el.attr("style", style);
        classesInlined += inlined.length;
      }
      $el.removeAttr("class");
    });
  }

  const rewritten = $.html();
  const rewriteMs = performance.now() - rewriteStarted;

  let output = rewritten;
  let sanitizeMs = 0;
  let elementsRemoved = 0;
  if (opts.sanitize) {
    const sanitizeStarted = performance.now();
    output = sanitizeHtml(rewritten, SANITIZE_CONFIG);
    sanitizeMs = performance.now() - sanitizeStarted;
    const dangerousOut = loadFragment(output)(DANGEROUS_SELECTOR).length;
    elementsRemoved = Math.max(0, dangerousIn - dangerousOut);
  }

  return {
    html: output,
    rewriteMs: Number(rewriteMs.toFixed(3)),
    sanitizeMs: Number(sanitizeMs.toFixed(3)),
    bytesIn,
    bytesOut: Buffer.byteLength(output),
    linksRewritten,
    classesInlined,
    elementsRemoved,
  };
}
