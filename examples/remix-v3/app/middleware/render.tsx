// Request-scoped renderer: actions call context.render(<Node/>) and get a
// streamed HTML response. Trimmed from the `remix new` scaffold — this example
// ships no browser modules, so the asset-server/client-entry resolution hooks
// are omitted.
import { renderWith } from 'remix/middleware/render'
import { createHtmlResponse } from 'remix/response/html'
import type { RemixNode } from 'remix/ui'
import { renderToStream } from 'remix/ui/server'

export function render() {
  return renderWith(
    ({ request }) =>
      function render(node: RemixNode, init?: ResponseInit) {
        const stream = renderToStream(node, {
          frameSrc: request.url,
          signal: request.signal,
        })

        return createHtmlResponse(stream, init)
      },
  )
}
