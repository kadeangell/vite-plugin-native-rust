// Correctness checks for the /transform demo. Speed claims are worthless if
// the output is wrong, so the route runs these on every transform and renders
// the results: the UTM/inline/sanitize invariants must actually hold on the
// OUTPUT, and the Rust and JS implementations must agree on what they did.

export interface TransformCounts {
  html: string;
  linksRewritten: number;
  classesInlined: number;
  elementsRemoved: number;
}

export interface TransformOptions {
  utmSource: string;
  inlineStyles: boolean;
  sanitize: boolean;
}

export interface CorrectnessCheck {
  name: string;
  pass: boolean;
  detail: string;
}

// Values from the shared class → style map; if any class was inlined, at
// least one of these must appear in the output.
const STYLE_MARKERS = ["display:inline-block", "font-size:24px", "line-height:1.6"];

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

function utmCheck(html: string): CorrectnessCheck {
  const absolute = extractHrefs(html).filter((href) => /^https?:\/\//i.test(href.trim()));
  const untagged = absolute.filter((href) => !href.toLowerCase().includes("utm_source="));
  return {
    name: "Every absolute http(s) link is UTM-tagged",
    pass: untagged.length === 0,
    detail:
      untagged.length === 0
        ? `${absolute.length} absolute links, all carry utm_source`
        : `${untagged.length} of ${absolute.length} links missing utm_source: ${untagged[0]}`,
  };
}

function inlineChecks(html: string, classesInlined: number): CorrectnessCheck[] {
  const classAttrs = html.match(/\sclass="/g)?.length ?? 0;
  const hasMarker = STYLE_MARKERS.some((marker) => html.includes(marker));
  return [
    {
      name: "No class attributes survive inlining",
      pass: classAttrs === 0,
      detail: classAttrs === 0 ? "0 class attributes in output" : `${classAttrs} class attributes remain`,
    },
    {
      name: "Mapped classes became inline styles",
      pass: classesInlined === 0 || hasMarker,
      detail: hasMarker
        ? `${classesInlined} classes inlined; mapped CSS present in output`
        : `${classesInlined} classes reported inlined but no mapped CSS found`,
    },
  ];
}

function sanitizeChecks(html: string): CorrectnessCheck[] {
  const scripts = html.match(/<script\b/gi)?.length ?? 0;
  const handlers = html.match(/\son\w+\s*=/gi)?.length ?? 0;
  const jsUrls = html.match(/["'\s]javascript:/gi)?.length ?? 0;
  return [
    {
      name: "No <script> elements survive",
      pass: scripts === 0,
      detail: scripts === 0 ? "0 script tags in output" : `${scripts} script tags remain`,
    },
    {
      name: "No inline event handlers survive",
      pass: handlers === 0,
      detail: handlers === 0 ? "0 on* attributes in output" : `${handlers} on* attributes remain`,
    },
    {
      name: "No javascript: URLs survive",
      pass: jsUrls === 0,
      detail: jsUrls === 0 ? "0 javascript: URLs in output" : `${jsUrls} javascript: URLs remain`,
    },
  ];
}

function parityChecks(rust: TransformCounts, js: TransformCounts): CorrectnessCheck[] {
  return [
    {
      name: "Rust and JS agree on links rewritten",
      pass: rust.linksRewritten === js.linksRewritten,
      detail: `Rust ${rust.linksRewritten}, JS ${js.linksRewritten}`,
    },
    {
      name: "Rust and JS agree on classes inlined",
      pass: rust.classesInlined === js.classesInlined,
      detail: `Rust ${rust.classesInlined}, JS ${js.classesInlined}`,
    },
    {
      name: "Rust and JS agree on dangerous elements stripped",
      pass: rust.elementsRemoved === js.elementsRemoved,
      detail: `Rust ${rust.elementsRemoved}, JS ${js.elementsRemoved}`,
    },
  ];
}

/** Run every applicable invariant against the Rust output (+ JS parity). */
export function runChecks(
  rust: TransformCounts,
  js: TransformCounts,
  opts: TransformOptions,
): CorrectnessCheck[] {
  const checks: CorrectnessCheck[] = [];
  if (opts.utmSource !== "") {
    checks.push(utmCheck(rust.html));
  }
  if (opts.inlineStyles) {
    checks.push(...inlineChecks(rust.html, rust.classesInlined));
  }
  if (opts.sanitize) {
    checks.push(...sanitizeChecks(rust.html));
  }
  checks.push(...parityChecks(rust, js));
  return checks;
}
