import { createController } from 'remix/router'

import { routes } from '../routes.ts'
import { add, sumTo } from '../rust.server.ts'
import { RustPage } from '../ui/rust-page.tsx'

/** Small enough to be instant, big enough to prove the async path: 500500. */
const SUM_TO_N = 1_000

export default createController(routes, {
  actions: {
    async home(context) {
      const sum = add(2, 3)
      const start = performance.now()
      // Runs on napi-rs's worker pool — the Node event loop stays free.
      const total = await sumTo(SUM_TO_N)
      const elapsedMs = performance.now() - start

      return context.render(
        <RustPage sum={sum} total={total} n={SUM_TO_N} elapsedMs={elapsedMs} />,
      )
    },
    async rustJson() {
      const sum = add(2, 3)
      const total = await sumTo(SUM_TO_N)
      return Response.json({ add: sum, sumTo: total, n: SUM_TO_N })
    },
  },
})
