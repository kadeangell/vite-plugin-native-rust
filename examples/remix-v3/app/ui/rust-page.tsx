import type { Handle } from 'remix/ui'
import { css } from 'remix/ui'

import { Document } from './document.tsx'

export interface RustPageProps {
  /** add(2, 3) — expected 5. */
  sum: number
  /** await sumTo(n) — expected 500500 for n = 1000. */
  total: number
  n: number
  elapsedMs: number
}

export function RustPage(handle: Handle<RustPageProps>) {
  return () => {
    const { sum, total, n, elapsedMs } = handle.props

    return (
      <Document title="Remix 3 + native Rust">
        <main mix={css({ maxWidth: '42rem', margin: '0 auto', padding: '2rem' })}>
          <h1>Remix 3 + napi-rs native Rust</h1>
          <p>
            Both values below were computed server-side by the Rust crate in{' '}
            <code>native/</code>, compiled to a napi-rs addon and loaded with a plain{' '}
            <code>require()</code> — no Vite, because Remix 3 has no Vite pipeline (see the
            README).
          </p>
          <p>
            <code>add(2, 3)</code> = <strong data-testid="add">{sum}</strong> (sync, main
            thread)
          </p>
          <p>
            <code>await sumTo({n})</code> ={' '}
            <strong data-testid="sum-to">{total}</strong> (async, napi worker pool,{' '}
            {elapsedMs.toFixed(2)}ms)
          </p>
          <p>
            JSON version: <a href="/api/rust">/api/rust</a>
          </p>
        </main>
      </Document>
    )
  }
}
