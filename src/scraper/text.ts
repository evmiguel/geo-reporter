import * as cheerio from 'cheerio'

export function extractVisibleText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, template').remove()
  const raw = $('body').text() || $.root().text()
  return raw.replace(/\s+/g, ' ').trim()
}
