import { Form, Link } from "react-router";

import { DEMOS } from "../demos";
import { ensureMiniIndex, searchMini } from "../search-minisearch.server";
import { ensureIndex, search, type SearchHit } from "../search-native.server";
import type { Route } from "./+types/search";

const demo = DEMOS.find((d) => d.path === "/search")!;

const RESULT_LIMIT = 10;
const MAX_QUERY_LEN = 200;
const EXAMPLE_QUERIES = [
  "rust memory safety",
  "postgresql query planning",
  "tantivy snippet highlighting",
] as const;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

interface QueryOutcome {
  hits: SearchHit[];
  tantivyMs: number;
  miniMs: number;
  miniTopTitles: string[];
}

const round = (ms: number): number => Number(ms.toFixed(3));

export async function loader({ request }: Route.LoaderArgs) {
  // Build both indexes up front (each a once-per-process no-op afterwards) so
  // the per-query timings below never include index construction.
  const stats = await ensureIndex();
  const miniStats = ensureMiniIndex();

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LEN);

  if (q === "") {
    return { q, stats, miniStats, outcome: null, error: null };
  }

  try {
    const tantivyStart = performance.now();
    const hits = search(q, RESULT_LIMIT);
    const tantivyMs = round(performance.now() - tantivyStart);

    const miniStart = performance.now();
    const miniHits = searchMini(q, RESULT_LIMIT);
    const miniMs = round(performance.now() - miniStart);

    const outcome: QueryOutcome = {
      hits,
      tantivyMs,
      miniMs,
      miniTopTitles: miniHits.slice(0, 3).map((hit) => hit.title),
    };
    return { q, stats, miniStats, outcome, error: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Search failed";
    return { q, stats, miniStats, outcome: null, error: message };
  }
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default function Search({ loaderData }: Route.ComponentProps) {
  const { q, stats, miniStats, outcome, error } = loaderData;
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "44rem",
        margin: "0 auto",
        padding: "2.5rem 1.5rem",
        color: "#1a1a1a",
      }}
    >
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to="/">← Showcase</Link>
      </p>
      <h1 style={{ marginBottom: "0.4rem" }}>{demo.title}</h1>
      <p style={{ fontFamily: mono, color: "#7a5b00" }}>{demo.crate}</p>
      <p style={{ color: "#555" }}>{demo.blurb}</p>

      <Form
        method="get"
        style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem" }}
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search 10,000 docs…"
          maxLength={MAX_QUERY_LEN}
          aria-label="Search query"
          style={{
            flex: 1,
            padding: "0.6rem 0.8rem",
            fontSize: "1rem",
            border: "1px solid #ccc",
            borderRadius: "8px",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "0.6rem 1.2rem",
            fontSize: "1rem",
            border: "1px solid #1a1a1a",
            borderRadius: "8px",
            background: "#1a1a1a",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Search
        </button>
      </Form>

      <p style={{ marginTop: "0.75rem", color: "#888", fontSize: "0.9rem" }}>
        Try:{" "}
        {EXAMPLE_QUERIES.map((example, i) => (
          <span key={example}>
            {i > 0 && " · "}
            <Link to={`/search?q=${encodeURIComponent(example)}`}>{example}</Link>
          </span>
        ))}
      </p>

      <p
        style={{
          marginTop: "1.25rem",
          padding: "0.75rem 1rem",
          background: "#f6f6f6",
          borderRadius: "8px",
          color: "#555",
          fontSize: "0.9rem",
        }}
      >
        Index: <strong>{stats.docCount.toLocaleString()}</strong> docs · tantivy
        build <strong>{stats.buildMs.toFixed(1)} ms</strong> · minisearch build{" "}
        <strong>{miniStats.buildMs.toFixed(1)} ms</strong>. Both indexes are
        built once per server process and shared across requests (the Rust side
        in a <code>OnceLock</code> static) — the <em>first</em> request pays the
        build honestly; everything after reuses it.
      </p>

      {error !== null && (
        <p style={{ marginTop: "1.5rem", color: "#b00020" }}>
          Search failed: {error}
        </p>
      )}

      {outcome !== null && (
        <>
          <p
            style={{ marginTop: "1.5rem", fontFamily: mono, fontSize: "0.95rem" }}
          >
            tantivy: <strong>{outcome.tantivyMs} ms</strong> · minisearch:{" "}
            <strong>{outcome.miniMs} ms</strong>{" "}
            <span style={{ color: "#888" }}>
              (this query, same corpus — see{" "}
              <Link to="/benchmarks">/benchmarks</Link> for p50/p95)
            </span>
          </p>

          {outcome.hits.length === 0 ? (
            <p style={{ marginTop: "1.5rem", color: "#888" }}>
              No results for “{q}”.
            </p>
          ) : (
            <ol style={{ marginTop: "1rem", paddingLeft: "1.4rem" }}>
              {outcome.hits.map((hit, rank) => (
                <li key={`${rank}-${hit.title}`} style={{ margin: "0.9rem 0" }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>
                    {hit.title}{" "}
                    <span
                      style={{ color: "#aaa", fontWeight: 400, fontSize: "0.85rem" }}
                    >
                      score {hit.score.toFixed(2)}
                    </span>
                  </p>
                  <p
                    style={{
                      margin: "0.15rem 0 0",
                      color: "#555",
                      fontSize: "0.92rem",
                    }}
                    // Safe: tantivy's SnippetGenerator HTML-escapes all text and
                    // only injects <b> around matched terms (the crate's fallback
                    // path escapes too).
                    dangerouslySetInnerHTML={{ __html: hit.snippet }}
                  />
                </li>
              ))}
            </ol>
          )}

          {outcome.miniTopTitles.length > 0 && (
            <p style={{ marginTop: "1.5rem", color: "#888", fontSize: "0.88rem" }}>
              minisearch top hits (ranking parity check):{" "}
              {outcome.miniTopTitles.join(" · ")}
            </p>
          )}
        </>
      )}
    </main>
  );
}
