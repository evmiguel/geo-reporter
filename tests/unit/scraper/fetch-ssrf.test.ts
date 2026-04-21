import { describe, it, expect, vi } from 'vitest'
import { fetchHtml, FetchError } from '../../../src/scraper/fetch.ts'
import { SSRFBlockedError } from '../../../src/scraper/ssrf.ts'
import type { FetchLike } from '../../../src/scraper/safe-fetch.ts'

describe('fetchHtml SSRF defense (always on — no NODE_ENV gate)', () => {
  it('rejects a hostname that resolves to a private IP, even in dev', async () => {
    const resolveHost = vi.fn().mockRejectedValue(new SSRFBlockedError('10.0.0.1', '10.0.0.1'))
    const fetcher = vi.fn()
    await expect(
      fetchHtml('http://10.0.0.1/', {}, { resolveHost, fetcher: fetcher as unknown as FetchLike }),
    ).rejects.toMatchObject({ name: 'FetchError', reason: 'network' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects cloud metadata IP (169.254.169.254)', async () => {
    const resolveHost = vi.fn().mockRejectedValue(
      new SSRFBlockedError('169.254.169.254', '169.254.169.254'),
    )
    const fetcher = vi.fn()
    await expect(
      fetchHtml('http://169.254.169.254/', {}, { resolveHost, fetcher: fetcher as unknown as FetchLike }),
    ).rejects.toBeInstanceOf(FetchError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a public → private redirect chain', async () => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SSRFBlockedError('10.0.0.5', '10.0.0.5'))
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } }),
    )
    await expect(
      fetchHtml('https://attacker.example/', {}, { resolveHost, fetcher: fetcher as unknown as FetchLike }),
    ).rejects.toMatchObject({ name: 'FetchError', reason: 'network' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
