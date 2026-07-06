import type { Handle, RemixNode } from 'remix/ui'
import { css } from 'remix/ui'

export interface DocumentProps {
  children?: RemixNode
  title?: string
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, title = 'Remix 3 + native Rust' } = handle.props

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
        </head>
        <body mix={css({ margin: 0, fontFamily: 'system-ui, sans-serif' })}>{children}</body>
      </html>
    )
  }
}
