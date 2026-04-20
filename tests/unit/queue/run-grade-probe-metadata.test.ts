import { describe, it, expect } from 'vitest'
import type { NewProbe } from '../../../src/store/types.ts'
import { runDiscoverabilityCategory } from '../../../src/queue/workers/run-grade/categories.ts'
import { MockProvider } from '../../../src/llm/providers/index.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'

const SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'Stripe offers payments',
  structured: {
    jsonld: [],
    og: { title: 'Stripe', description: 'Payments', image: 'https://stripe.com/og.png' },
    meta: { title: 'Stripe', description: 'Payment processor', canonical: 'https://stripe.com', twitterCard: 'summary' },
    headings: { h1: ['Stripe'], h2: [] },
    robots: null,
    sitemap: { present: false, url: 'https://stripe.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://stripe.com/llms.txt' },
  },
}

describe('run-grade writes model in probes.metadata', () => {
  it('includes metadata.model for discoverability probes', async () => {
    const created: NewProbe[] = []
    const deps = {
      store: {
        createProbe: async (input: NewProbe) => { created.push(input); return { id: 'x', ...input, createdAt: new Date() } as never },
      },
      redis: { publish: async () => 0 } as never,
    } as never
    const provider = new MockProvider({ id: 'claude', responses: () => 'stripe.com is a payment processor' })

    await runDiscoverabilityCategory({
      gradeId: 'g1',
      grade: { url: 'https://stripe.com', domain: 'stripe.com' } as never,
      scrape: SCRAPE,
      probers: [provider],
      deps,
    })

    expect(created.length).toBeGreaterThan(0)
    for (const probe of created) {
      expect((probe.metadata as { model?: string }).model).toBe('mock:claude')
    }
  })
})
