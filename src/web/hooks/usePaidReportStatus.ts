import { useEffect, useState } from 'react'
import { getReportStatus } from '../lib/api.ts'
import type { PdfStatus } from '../lib/types.ts'

interface Result { pdf: PdfStatus; loading: boolean }

export function usePaidReportStatus(reportId: string | null, token: string | null): Result {
  const [pdf, setPdf] = useState<PdfStatus>('pending')
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    if (!reportId || !token) { setLoading(false); return }
    let cancelled = false

    async function tick(): Promise<void> {
      const res = await getReportStatus(reportId!, token!)
      if (cancelled) return
      setLoading(false)
      if (res) setPdf(res.pdf)
      if (!res || res.pdf === 'pending') {
        setTimeout(() => { if (!cancelled) void tick() }, 2000)
      }
    }
    void tick()
    return () => { cancelled = true }
  }, [reportId, token])

  return { pdf, loading }
}
