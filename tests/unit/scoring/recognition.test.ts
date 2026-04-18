import { describe, expect, it } from 'vitest'
import { scoreRecognition } from '../../../src/scoring/recognition.ts'

describe('scoreRecognition', () => {
  it('returns 0 for "I don\'t know" responses', () => {
    expect(scoreRecognition({ text: "I don't know about example.com.", domain: 'example.com' })).toBe(0)
    expect(scoreRecognition({ text: "I'm not familiar with that site.", domain: 'example.com' })).toBe(0)
  })

  it('returns 0 when neither brand nor domain is mentioned', () => {
    expect(scoreRecognition({ text: 'It is a search engine.', domain: 'example.com' })).toBe(0)
  })

  it('returns 50 baseline for bare brand mention with no specific facts', () => {
    expect(scoreRecognition({ text: 'Example is a website.', domain: 'example.com' })).toBe(50)
  })

  it('adds 20 for one specific-detail hint', () => {
    expect(scoreRecognition({
      text: 'Example is a company that offers products.',
      domain: 'example.com',
    })).toBe(70)
  })

  it('adds 35 for two hints', () => {
    expect(scoreRecognition({
      text: 'Example was founded in 1998 and is a leading search engine.',
      domain: 'example.com',
    })).toBe(85)
  })

  it('adds 50 for three or more hints', () => {
    expect(scoreRecognition({
      text: 'Example was founded in 1998, is headquartered in California, and is the world\'s largest search engine with billions of users.',
      domain: 'example.com',
    })).toBe(100)
  })

  it('subtracts 20 for hedge phrases', () => {
    expect(scoreRecognition({
      text: "I think Example might be a search engine, but I'm not sure.",
      domain: 'example.com',
    })).toBe(0)
  })

  it('clamps score to 0–100', () => {
    expect(scoreRecognition({ text: 'Example is unknown.', domain: 'example.com' })).toBeGreaterThanOrEqual(0)
    expect(scoreRecognition({
      text: 'Example was founded in 1998, headquartered in California, world\'s largest search engine, billions of users, and offers many products.',
      domain: 'example.com',
    })).toBeLessThanOrEqual(100)
  })
})
