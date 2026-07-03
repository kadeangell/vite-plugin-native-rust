import { Link } from "react-router";

export function meta() {
  return [{ title: "Vite Rust Import Plugin Testbed" }];
}

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Vite Rust Import Plugin Testbed</h1>
      <p>Routes for exercising the future Rust-to-native-addon Vite plugin:</p>
      <ul>
        <li>
          <Link to="/slow-io">/slow-io</Link> — slow IO-bound loader (~3s fake
          DB/API wait)
        </li>
        <li>
          <Link to="/slow-cpu">/slow-cpu</Link> — slow CPU-bound loader (~2-4s
          of synchronous hashing)
        </li>
        <li>
          <Link to="/slow-cpu-rust">/slow-cpu-rust</Link> — same 6M-iteration
          workload run in Rust off the event loop (A/B against /slow-cpu)
        </li>
        <li>
          <a href="/api/hello?q=test">/api/hello?q=test</a> — resource route
          returning JSON
        </li>
        <li>
          <Link to="/static">/static</Link> — frontend-only route, no loader
        </li>
      </ul>
    </main>
  );
}
