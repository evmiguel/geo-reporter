import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractVisibleText } from '../../../src/scraper/text.ts'

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

describe('extractVisibleText', () => {
  it('strips script, style, and noscript tags', () => {
    const html = '<html><body><p>keep</p><script>drop()</script><style>.x{}</style><noscript>drop</noscript></body></html>'
    expect(extractVisibleText(html)).toBe('keep')
  })

  it('normalizes runs of whitespace to single spaces', () => {
    const html = '<p>a  \n\n  b\t\tc</p>'
    expect(extractVisibleText(html)).toBe('a b c')
  })

  it('returns empty string for empty body', () => {
    expect(extractVisibleText(fixture('empty.html'))).toBe('')
  })

  it('extracts >1000 chars from rich fixture', () => {
    expect(extractVisibleText(fixture('rich.html')).length).toBeGreaterThan(1000)
  })

  it('sparse SPA fixture yields very little text', () => {
    expect(extractVisibleText(fixture('sparse.html')).length).toBeLessThan(50)
  })
})
