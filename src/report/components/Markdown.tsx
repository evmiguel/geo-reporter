import React from 'react'
import ReactMarkdown from 'react-markdown'

interface MarkdownProps {
  /** LLM-generated text containing markdown (headers, lists, bold, code, links). */
  children: string
  /** Optional class on the wrapping div for scoped typography. */
  className?: string
}

// Renders LLM-authored markdown as HTML for the report. By default react-markdown
// escapes raw HTML (XSS-safe) and doesn't load external resources. We disable
// images explicitly anyway to keep PDF render hermetic — every byte the
// Playwright renderer needs lives inline.
export function Markdown({ children, className }: MarkdownProps): JSX.Element {
  return (
    <div className={className ?? 'markdown'}>
      <ReactMarkdown
        components={{
          // Strip image tags to prevent external resource loads in PDF render.
          img: () => null,
          // Force links to open in a new tab without leaking the referrer.
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{linkChildren}</a>
          ),
        }}
      >{children}</ReactMarkdown>
    </div>
  )
}
