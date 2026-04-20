import { Worker, type Worker as BullWorker } from 'bullmq'
import type Redis from 'ioredis'
import { pdfQueueName, type PdfJob } from '../../queue/queues.ts'
import { renderReport } from '../render.tsx'
import { buildReportInput } from '../build-input.ts'
import type { RenderPdfDeps } from './deps.ts'

export interface RenderPdfJob { reportId: string }

export async function processRenderPdf(deps: RenderPdfDeps, job: RenderPdfJob): Promise<void> {
  const record = await deps.store.getReportById(job.reportId)
  if (!record) throw new Error(`render-pdf: report ${job.reportId} not found or not ready`)
  const input = buildReportInput(record)
  // Omit the "Download PDF" link when rendering HTML destined for the PDF itself —
  // it would otherwise ship a self-pointing server-relative URL inside the downloaded artifact.
  const html = renderReport(input, { pdfUrl: null })
  const bytes = await deps.browserPool.withPage(async (page) => {
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    return page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' } })
  })
  await deps.store.writeReportPdf(job.reportId, bytes)
}

export function registerRenderPdfWorker(deps: RenderPdfDeps, connection: Redis): BullWorker<PdfJob> {
  return new Worker<PdfJob>(
    pdfQueueName,
    async (job) => {
      try {
        await processRenderPdf(deps, { reportId: job.data.reportId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await deps.store.setReportPdfStatus(job.data.reportId, 'failed', message)
        throw err
      }
    },
    { connection, concurrency: 1 },
  )
}
