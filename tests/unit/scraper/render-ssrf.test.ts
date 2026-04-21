import { describe, it, expect } from 'vitest'
import { render } from '../../../src/scraper/render.ts'

describe('render SSRF defense (always on — no NODE_ENV gate)', () => {
  it('rejects private IP before launching Playwright', async () => {
    await expect(render('http://10.0.0.1/')).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'network',
    })
  })

  it('rejects cloud metadata IP', async () => {
    await expect(render('http://169.254.169.254/')).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'network',
    })
  })

  it('rejects non-http(s) protocols before launching Playwright', async () => {
    await expect(render('file:///etc/passwd')).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'network',
    })
  })
})
