import type { GradeStore } from '../../store/types.ts'
import type { Page } from 'playwright'

export interface RenderPdfDeps {
  store: Pick<GradeStore, 'getReportById' | 'writeReportPdf' | 'setReportPdfStatus'>
  browserPool: { withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> }
}
