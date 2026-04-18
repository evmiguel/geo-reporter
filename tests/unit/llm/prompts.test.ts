import { describe, expect, it } from 'vitest'
import {
  promptRecognition,
  promptCoverage,
  promptCitation,
  promptDiscoverabilityGenerator,
  promptAccuracyGenerator,
} from '../../../src/llm/prompts.ts'

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
