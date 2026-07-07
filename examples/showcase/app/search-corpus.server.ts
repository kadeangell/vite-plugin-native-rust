// The search demo's corpus, shared by BOTH engines so the A/B is honest:
// the Rust crate embeds the same file via `include_str!`, and this module
// imports the identical bytes through Vite's `?raw` so the minisearch baseline
// indexes exactly what tantivy indexes.
//
// The corpus is synthetic and deterministic — see crates/search/corpus/
// generate.mjs for provenance (MIT, no third-party data).
import corpusRaw from "../crates/search/corpus/corpus.jsonl?raw";

export interface CorpusDoc {
  /// Zero-based line number — the same implicit id the Rust indexer uses.
  id: number;
  title: string;
  body: string;
}

function parseCorpus(raw: string): readonly CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`corpus line ${i + 1}: invalid JSON`);
    }
    const doc = parsed as { title?: unknown; body?: unknown };
    if (typeof doc.title !== "string" || typeof doc.body !== "string") {
      throw new Error(
        `corpus line ${i + 1}: expected {"title": string, "body": string}`,
      );
    }
    docs.push({ id: docs.length, title: doc.title, body: doc.body });
  }
  if (docs.length === 0) {
    throw new Error("corpus is empty — run crates/search/corpus/generate.mjs");
  }
  return docs;
}

export const CORPUS: readonly CorpusDoc[] = parseCorpus(corpusRaw);
