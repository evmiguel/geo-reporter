import type { ReportRecord } from '../../src/store/types.ts'

export function makeReportRecord(): ReportRecord {
  const gradeId = '11111111-1111-1111-1111-111111111111'
  const reportId = '22222222-2222-2222-2222-222222222222'
  const createdAt = new Date('2026-04-19T14:32:00Z')
  return {
    report: { id: reportId, gradeId, token: 't'.repeat(64), createdAt },
    grade: {
      id: gradeId, url: 'https://stripe.com', domain: 'stripe.com',
      tier: 'paid', cookie: null, userId: null, status: 'done',
      overall: 87, letter: 'B+',
      scores: { discoverability: 78, recognition: 85, accuracy: 62, coverage: 71, citation: 80, seo: 93 } as never,
      createdAt, updatedAt: createdAt,
    },
    scrape: {
      id: 's1', gradeId, rendered: false,
      html: '<html></html>', text: 'Stripe offers payment processing. Standard: 2.9% + 30¢.',
      structured: {} as never, fetchedAt: createdAt,
    },
    probes: [
      { id: 'p1', gradeId, category: 'discoverability', provider: 'claude', prompt: 'What is stripe.com?', response: 'A payment processor...', score: 78, metadata: { label: 'self-gen', model: 'claude-sonnet-4-6' } as never, createdAt },
      { id: 'p2', gradeId, category: 'recognition', provider: 'claude', prompt: 'What does stripe do?', response: 'Payment processing.', score: 85, metadata: { label: 'brand', model: 'claude-sonnet-4-6' } as never, createdAt },
      { id: 'p3', gradeId, category: 'accuracy', provider: null, prompt: '', response: 'What are stripe pricing tiers?', score: null, metadata: { role: 'generator' } as never, createdAt },
      { id: 'p4', gradeId, category: 'accuracy', provider: 'claude', prompt: 'What are stripe pricing tiers?', response: 'Standard: 2.9% + 30¢.', score: 100, metadata: { role: 'verify', model: 'claude-sonnet-4-6', rationale: 'correct' } as never, createdAt },
      { id: 'p5', gradeId, category: 'seo', provider: null, prompt: '', response: 'llms.txt missing', score: 0, metadata: { signal: 'llms_txt', pass: false } as never, createdAt },
      { id: 'p6', gradeId, category: 'seo', provider: null, prompt: '', response: 'robots.txt OK', score: 100, metadata: { signal: 'robots_txt', pass: true } as never, createdAt },
    ],
    recommendations: [
      { id: 'r1', gradeId, rank: 1, title: 'Publish canonical pricing page', category: 'accuracy', impact: 5, effort: 2, rationale: 'LLMs invented pricing.', how: 'Add JSON-LD Product.', createdAt },
      { id: 'r2', gradeId, rank: 2, title: 'Add llms.txt', category: 'discoverability', impact: 4, effort: 1, rationale: 'Missing signal.', how: 'Create /llms.txt.', createdAt },
    ],
  }
}
