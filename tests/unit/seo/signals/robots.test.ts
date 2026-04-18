import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateRobots } from '../../../../src/seo/signals/robots.ts'

function makeScrape(robots: string | null): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateRobots', () => {
  it('passes when robots.txt is absent (null)', () => {
    const r = evaluateRobots(makeScrape(null))
    expect(r).toMatchObject({ name: 'robots', pass: true, weight: 10 })
    expect(r.detail).toMatch(/absent|permissive/i)
  })

  it('passes when all LLM bots are allowed by explicit allow-all', () => {
    expect(evaluateRobots(makeScrape('User-agent: *\nAllow: /')).pass).toBe(true)
  })

  it('passes when a specific path is disallowed but / is still allowed', () => {
    expect(evaluateRobots(makeScrape('User-agent: *\nDisallow: /private/')).pass).toBe(true)
  })

  it('fails when GPTBot is specifically disallowed from /', () => {
    const r = evaluateRobots(makeScrape('User-agent: GPTBot\nDisallow: /'))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('GPTBot')
  })

  it('fails and lists all three bots when * disallows /', () => {
    const r = evaluateRobots(makeScrape('User-agent: *\nDisallow: /'))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('GPTBot')
    expect(r.detail).toContain('ClaudeBot')
    expect(r.detail).toContain('PerplexityBot')
  })

  it('reports only the specific bot when one is blocked and others are allowed', () => {
    const txt = 'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /'
    const r = evaluateRobots(makeScrape(txt))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('ClaudeBot')
    expect(r.detail).not.toContain('GPTBot')
    expect(r.detail).not.toContain('PerplexityBot')
  })
})
