import React from 'react'

interface LayoutProps {
  title: string
  css: string
  children: React.ReactNode
}

export function Layout({ title, css, children }: LayoutProps): JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  )
}
