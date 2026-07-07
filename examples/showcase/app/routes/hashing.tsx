import { Form, Link, useNavigation } from "react-router";

import { DEMOS } from "../demos";
import {
  runEventLoopExperiment,
  type ExperimentResult,
  type ExperimentRun,
} from "../hashing-experiment.server";
import { hashPassword, verifyPassword } from "../hashing.server";
import type { Route } from "./+types/hashing";

const demo = DEMOS.find((d) => d.path === "/hashing")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

const MAX_PASSWORD_LENGTH = 256;
// A deliberately-corrupt PHC string for the Result -> exception demo.
const CORRUPT_HASH = "$argon2id$v=19$m=65536,t=3,p=1$not!valid!base64$????";
const EXPERIMENT_PASSWORD = "correct horse battery staple";

interface HashOutcome {
  kind: "hash";
  hash: string;
  hashMs: number;
  verifiedCorrect: boolean;
  verifiedWrong: boolean;
  verifyMs: number;
  corruptHash: string;
  corruptError: string;
}

interface ExperimentOutcome {
  kind: "experiment";
  result: ExperimentResult;
}

interface ErrorOutcome {
  kind: "error";
  message: string;
}

type ActionData = HashOutcome | ExperimentOutcome | ErrorOutcome;

const round1 = (ms: number): number => Number(ms.toFixed(1));

async function runHashDemo(password: string): Promise<HashOutcome> {
  const hashStart = performance.now();
  const hash = await hashPassword(password);
  const hashMs = performance.now() - hashStart;

  // Round-trip verification: right password resolves true, wrong password
  // resolves FALSE (an expected outcome, not an exception).
  const verifyStart = performance.now();
  const verifiedCorrect = await verifyPassword(password, hash);
  const verifyMs = performance.now() - verifyStart;
  const verifiedWrong = await verifyPassword(`${password}-nope`, hash);

  // Error propagation: a malformed stored hash makes the Rust fn return
  // Err(...), which napi-rs surfaces as a rejected Promise — an ordinary
  // catchable JS exception, not a panic or a crash.
  let corruptError = "(no error thrown — unexpected)";
  try {
    await verifyPassword(password, CORRUPT_HASH);
  } catch (error: unknown) {
    corruptError = error instanceof Error ? error.message : String(error);
  }

  return {
    kind: "hash",
    hash,
    hashMs: round1(hashMs),
    verifiedCorrect,
    verifiedWrong,
    verifyMs: round1(verifyMs),
    corruptHash: CORRUPT_HASH,
    corruptError,
  };
}

export async function action({
  request,
}: Route.ActionArgs): Promise<ActionData> {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "experiment") {
    return {
      kind: "experiment",
      result: await runEventLoopExperiment(EXPERIMENT_PASSWORD),
    };
  }

  if (intent === "hash") {
    const password = form.get("password");
    if (typeof password !== "string" || password.length === 0) {
      return { kind: "error", message: "Enter a password to hash." };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return {
        kind: "error",
        message: `Password too long (max ${MAX_PASSWORD_LENGTH} characters).`,
      };
    }
    // The password lives only in this request: hashed in memory, never
    // stored, never logged, never echoed back to the client.
    return runHashDemo(password);
  }

  return { kind: "error", message: "Unknown action." };
}

const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const panel: React.CSSProperties = {
  border: "1px solid #e3e3e3",
  borderRadius: "8px",
  padding: "1rem 1.25rem",
  marginTop: "1rem",
  background: "#fafafa",
};

const cell: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  borderBottom: "1px solid #eee",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const labelCell: React.CSSProperties = { ...cell, textAlign: "left" };

function HashResult({ outcome }: { outcome: HashOutcome }) {
  return (
    <div style={panel}>
      <p style={{ margin: 0, color: "#555" }}>
        Hashed in <strong>{outcome.hashMs} ms</strong> — Argon2id, 64 MiB, t=3,
        p=1, computed off the event loop:
      </p>
      <p style={{ ...mono, wordBreak: "break-all", fontSize: "0.85rem" }}>
        {outcome.hash}
      </p>
      <ul style={{ color: "#333", lineHeight: 1.7 }}>
        <li>
          <code>verifyPassword(password, hash)</code> →{" "}
          <strong>{String(outcome.verifiedCorrect)}</strong> ({outcome.verifyMs}{" "}
          ms — verifying re-runs the full hash, so it costs the same as hashing,
          by design)
        </li>
        <li>
          <code>verifyPassword(wrongPassword, hash)</code> →{" "}
          <strong>{String(outcome.verifiedWrong)}</strong> — a wrong password is
          an expected outcome, so Rust returns <code>Ok(false)</code>, not an
          error
        </li>
      </ul>
      <h3 style={{ fontSize: "1rem", marginBottom: "0.25rem" }}>
        Rust <code>Err</code> → catchable JS exception
      </h3>
      <p style={{ color: "#555", margin: "0.25rem 0" }}>
        Verifying against a corrupted stored hash{" "}
        <code style={{ wordBreak: "break-all" }}>{outcome.corruptHash}</code>{" "}
        makes the Rust fn return <code>Err(...)</code>; napi-rs rejects the
        Promise and <code>catch</code> received:
      </p>
      <p style={{ ...mono, color: "#b00020", fontSize: "0.85rem" }}>
        {outcome.corruptError}
      </p>
    </div>
  );
}

function ExperimentRow({ run, label }: { run: ExperimentRun; label: string }) {
  return (
    <tr>
      <td style={labelCell}>{label}</td>
      <td style={cell}>{run.wallMs}</td>
      <td style={cell}>{run.probe.ticks}</td>
      <td style={cell}>{run.probe.maxLagMs}</td>
      <td style={cell}>{run.probe.meanLagMs}</td>
    </tr>
  );
}

function ExperimentResultView({ result }: { result: ExperimentResult }) {
  return (
    <div style={panel}>
      <p style={{ margin: "0 0 0.75rem", color: "#555" }}>
        {result.concurrency} concurrent hashes per mode, while a{" "}
        {result.probeIntervalMs} ms timer probed the event loop:
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={labelCell}>export shape</th>
            <th style={cell}>wall (ms)</th>
            <th style={cell}>probe ticks</th>
            <th style={cell}>max lag (ms)</th>
            <th style={cell}>mean lag (ms)</th>
          </tr>
        </thead>
        <tbody>
          <ExperimentRow
            run={result.sync}
            label="sync #[napi] fn (anti-pattern)"
          />
          <ExperimentRow run={result.async} label="async #[napi] fn" />
        </tbody>
      </table>
      <p style={{ color: "#555", fontSize: "0.9rem", lineHeight: 1.6 }}>
        Reading the numbers: the <strong>sync</strong> export runs all{" "}
        {result.concurrency} hashes back-to-back on the main thread — wall time
        is ~{result.concurrency}× one hash, and the probe timer could not fire
        at all during the stall, so its next tick reports the whole blocked
        span as one giant lag (that silence is exactly what every other request
        experiences: the server serves <em>nothing</em>). The{" "}
        <strong>async</strong> export runs the same hashes in parallel on
        napi-rs worker threads — wall time is ~1× one hash and the probe keeps
        ticking every ~{result.probeIntervalMs} ms with near-zero lag, i.e. the
        event loop stayed free to serve other traffic.
      </p>
    </div>
  );
}

export default function Hashing({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const pendingIntent =
    navigation.state === "submitting"
      ? navigation.formData?.get("intent")
      : null;

  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "50rem",
        margin: "0 auto",
        padding: "2.5rem 1.5rem",
        color: "#1a1a1a",
      }}
    >
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to="/">← Showcase</Link>
      </p>
      <h1>{demo.title}</h1>
      <p style={{ color: "#555" }}>{demo.blurb}</p>
      <p style={{ color: "#555" }}>
        Rust crate: <code>{demo.crate}</code>, ~90 lines of Rust behind a
        one-line import. Cost parameters are production-tuned Argon2id (RFC
        9106's 64 MiB, t=3) so every hash costs on the order of 100 ms{" "}
        <em>on purpose</em> — slow hashing is the security property, which is
        exactly why <strong>where</strong> it runs matters.
      </p>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={{ fontSize: "1.25rem" }}>Hash a password</h2>
        <p style={{ color: "#555" }}>
          Demo only: the password is hashed in memory and never stored, logged,
          or echoed back. Still, don't type a real one.
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.75rem" }}>
          <input type="hidden" name="intent" value="hash" />
          <input
            type="password"
            name="password"
            required
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="off"
            placeholder="a throwaway password"
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              border: "1px solid #ccc",
              borderRadius: "6px",
              font: "inherit",
            }}
          />
          <button type="submit" disabled={pendingIntent !== null}>
            {pendingIntent === "hash" ? "hashing…" : "Hash it"}
          </button>
        </Form>
        {actionData?.kind === "error" && (
          <p style={{ color: "#b00020" }}>{actionData.message}</p>
        )}
        {actionData?.kind === "hash" && <HashResult outcome={actionData} />}
      </section>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={{ fontSize: "1.25rem" }}>The event-loop experiment</h2>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          The same Rust function is exported twice: once as a plain{" "}
          <code>#[napi]</code> fn (runs on Node's main thread) and once as{" "}
          <code>#[napi] async fn</code> (runs on napi-rs worker threads). This
          button fires <strong>4 concurrent hashes through each</strong> while a
          5 ms timer keeps probing the event loop, and reports what the server
          lived through.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="experiment" />
          <button type="submit" disabled={pendingIntent !== null}>
            {pendingIntent === "experiment"
              ? "running (~1 s: 8 hashes + warm-up)…"
              : "Run the experiment"}
          </button>
        </Form>
        {actionData?.kind === "experiment" && (
          <ExperimentResultView result={actionData.result} />
        )}
      </section>
    </main>
  );
}
