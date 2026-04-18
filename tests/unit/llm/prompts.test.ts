import { describe, expect, it } from 'vitest'
import {
  promptRecognition,
  promptCoverage,
  promptCitation,
  promptDiscoverabilityGenerator,
  promptAccuracyGenerator,
  promptJudge,
  promptAccuracyVerifier,
} from '../../../src/llm/prompts.ts'
import type { ProbeForJudge } from '../../../src/llm/ground-truth.ts'

describe('promptRecognition', () => {
  it('returns two prompts embedding the domain', () => {
    const [a, b] = promptRecognition('acme.com')
    expect(a).toBe('What is acme.com?')
    expect(b).toBe('Have you heard of acme.com? If so, what is it known for?')
  })
})

describe('promptCoverage', () => {
  it('returns two prompts embedding the domain', () => {
    const [a, b] = promptCoverage('acme.com')
    expect(a).toBe('What does acme.com do? List their main products or services.')
    expect(b).toBe('Who is the target audience for acme.com?')
  })
})

describe('promptCitation', () => {
  it('asks for the official website URL', () => {
    expect(promptCitation('acme.com')).toBe('What is the official website for acme.com? Provide the URL.')
  })
})

describe('promptDiscoverabilityGenerator', () => {
  it('includes the scraped fields and instructs not to name the site', () => {
    const gt = { url: 'https://acme.com', domain: 'acme.com', title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'Body' }
    const out = promptDiscoverabilityGenerator(gt)
    expect(out).toContain('Do NOT reference the website by name.')
    expect(out).toContain('Title: Acme')
    expect(out).toContain('Description: Widgets')
    expect(out).toContain('H1: Welcome')
    expect(out).toContain('Body')
  })
})

describe('promptAccuracyGenerator', () => {
  it('asks for one factual question the scrape can answer', () => {
    const gt = { url: 'https://acme.com', domain: 'acme.com', title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'We sell yellow widgets.' }
    const out = promptAccuracyGenerator(gt)
    expect(out).toContain('one specific factual question')
    expect(out).toContain('Return only the question.')
    expect(out).toContain('We sell yellow widgets.')
  })
})

const DENSE_GT = {
  url: 'https://acme.com',
  domain: 'acme.com',
  title: 'Acme Widgets — the world\'s largest widget maker',
  description: 'We have been making widgets since 1902 in Springfield, serving millions of customers worldwide.',
  h1: 'Industrial widgets built to last',
  bodyExcerpt: 'Acme has been family-owned for four generations. Our flagship products include the A-100 and A-200 series, used by construction firms across North America.',
}

const SPARSE_GT = {
  url: 'https://acme.com',
  domain: 'acme.com',
  title: 'Acme',
  description: '',
  h1: '',
  bodyExcerpt: '',
}

const PROBES: ProbeForJudge[] = [
  { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'What does acme.com do?', response: 'Acme makes widgets.' },
  { key: 'probe_2', provider: 'gpt', category: 'coverage', prompt: 'Who is the target audience?', response: 'Construction firms.' },
]

describe('promptJudge', () => {
  it('dense branch includes scraped body excerpt as grounding', () => {
    const { prompt, probesByKey } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('Scraped body excerpt')
    expect(prompt).toContain('family-owned for four generations')
    expect(prompt).not.toContain('scrape is essentially empty')
    expect(probesByKey.size).toBe(2)
    expect(probesByKey.get('probe_1')?.provider).toBe('claude')
  })

  it('sparse branch instructs the judge to use its own knowledge', () => {
    const { prompt } = promptJudge(SPARSE_GT, PROBES)
    expect(prompt).toContain('the scrape is essentially empty')
    expect(prompt).not.toContain('family-owned for four generations')
  })

  it('emits every probe key in the prompt', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('probe_1:')
    expect(prompt).toContain('probe_2:')
  })

  it('requests JSON output keyed by probe key', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('"probe_N":')
    expect(prompt).toContain('Include every probe ID listed below')
  })

  it('includes provider, prompt, and response for each probe', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('Provider: claude')
    expect(prompt).toContain('Prompt: What does acme.com do?')
    expect(prompt).toContain('Response: Acme makes widgets.')
  })
})

describe('promptAccuracyVerifier', () => {
  it('includes URL, question, provider, answer, and JSON schema', () => {
    const out = promptAccuracyVerifier({
      gt: DENSE_GT,
      question: 'When was Acme founded?',
      providerId: 'claude',
      answer: 'Acme was founded in 1902.',
    })
    expect(out).toContain('URL: https://acme.com')
    expect(out).toContain('Question: When was Acme founded?')
    expect(out).toContain('Provider: claude')
    expect(out).toContain('Answer: Acme was founded in 1902.')
    expect(out).toContain('"correct":')
    expect(out).toContain('"confidence":')
    expect(out).toContain('"rationale":')
    expect(out).toContain('null')
  })

  it('includes the body excerpt as grounding', () => {
    const out = promptAccuracyVerifier({
      gt: DENSE_GT,
      question: 'q',
      providerId: 'gpt',
      answer: 'a',
    })
    expect(out).toContain('family-owned for four generations')
  })
})
