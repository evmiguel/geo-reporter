import { Hono } from 'hono'
import type { GradeStore } from '../../store/types.ts'
import { validateToken } from '../../report/token.ts'
import { renderReport } from '../../report/render.tsx'
import { buildReportInput } from '../../report/build-input.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ReportRouterDeps { store: GradeStore }

export function reportRouter(deps: ReportRouterDeps): Hono {
  const app = new Hono()

  // PDF route: register BEFORE the catch-all /:id so Hono matches the .pdf suffix first.
  // Hono treats literal dots in path segments as part of the param, so we match a single
  // `/:filename` that ends with `.pdf` and strip the suffix to get the UUID.
  app.get('/:filename{[0-9a-f-]+\\.pdf}', async (c) => {
    const filename = c.req.param('filename')
    const id = filename.replace(/\.pdf$/, '')
    const t = c.req.query('t') ?? ''
    if (!UUID_RE.test(id) || t === '') return c.notFound()
    const record = await deps.store.getReportById(id)
    if (!record) return c.notFound()
    if (!validateToken(t, record.report.token)) return c.notFound()

    const pdf = await deps.store.getReportPdf(id)
    if (!pdf || pdf.status === 'pending') return c.json({ status: 'pending' as const }, 202)
    if (pdf.status === 'failed') return c.json({ status: 'failed' as const }, 503)
    const bytes = pdf.bytes
    if (!bytes) return c.json({ status: 'pending' as const }, 202)
    // Hono's c.body expects Uint8Array<ArrayBuffer>; Buffer's underlying buffer
    // type is ArrayBufferLike, so copy into a fresh Uint8Array backed by an ArrayBuffer.
    const body = new Uint8Array(new ArrayBuffer(bytes.length))
    body.set(bytes)
    return c.body(body, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="geo-report-${record.grade.domain}.pdf"`,
      'cache-control': 'private, max-age=3600, immutable',
    })
  })

  app.get('/:id/status', async (c) => {
    const id = c.req.param('id')
    const t = c.req.query('t') ?? ''
    if (!UUID_RE.test(id) || t === '') return c.notFound()
    const record = await deps.store.getReportById(id)
    if (!record) return c.notFound()
    if (!validateToken(t, record.report.token)) return c.notFound()
    const pdf = await deps.store.getReportPdf(id)
    const pdfStatus = pdf?.status ?? ('pending' as const)
    return c.json({ html: 'ready' as const, pdf: pdfStatus })
  })

  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    const t = c.req.query('t') ?? ''
    if (!UUID_RE.test(id) || t === '') return c.notFound()
    const record = await deps.store.getReportById(id)
    if (!record) return c.notFound()
    if (!validateToken(t, record.report.token)) return c.notFound()
    const input = buildReportInput(record)
    const pdfUrl = `/report/${record.report.id}.pdf?t=${record.report.token}`
    const html = renderReport(input, { pdfUrl })
    return c.body(html, 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:",
    })
  })

  return app
}
