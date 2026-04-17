import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { scrape, shutdownBrowserPool } from '../../src/scraper/index.ts'

const RICH = `<!doctype html>
<html><head>
<title>Rich Static Page</title>
<meta name="description" content="A richly populated static page, fully rendered server-side, for integration testing the scraper fallback heuristics.">
<link rel="canonical" href="http://static.example/">
<meta property="og:title" content="Rich Static">
<meta property="og:image" content="https://img.example/og.png">
<script type="application/ld+json">{"@type":"Organization","name":"Static Co"}</script>
</head><body>
<h1>Hello</h1>
<h2>Details</h2>
<p>${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40)}</p>
</body></html>`

const SPA = `<!doctype html>
<html><head><title>SPA</title></head>
<body><div id="root"></div>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    var root = document.getElementById('root');
    var p = document.createElement('p');
    p.textContent = '${'client-rendered content '.repeat(80)}';
    root.appendChild(p);
  });
</script>
</body></html>`

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/rich') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(RICH)
      return
    }
    if (req.url === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SPA)
      return
    }
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nAllow: /')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
}, 30_000)

afterAll(async () => {
  await shutdownBrowserPool()
  await new Promise<void>((r) => server.close(() => r()))
}, 30_000)

describe('scrape — integration', () => {
  it('rich static page: rendered=false, structured data extracted', async () => {
    const r = await scrape(`${base}/rich`)
    expect(r.rendered).toBe(false)
    expect(r.text.length).toBeGreaterThan(1000)
    expect(r.structured.meta.title).toBe('Rich Static Page')
    expect(r.structured.og.title).toBe('Rich Static')
    expect(r.structured.jsonld).toHaveLength(1)
    expect(r.structured.headings.h1).toEqual(['Hello'])
    expect(r.structured.robots).toContain('User-agent')
    expect(r.structured.sitemap.present).toBe(false)
    expect(r.structured.llmsTxt.present).toBe(false)
  }, 30_000)

  it('SPA page: rendered=true, text extracted after client script fills the DOM', async () => {
    const r = await scrape(`${base}/spa`)
    expect(r.rendered).toBe(true)
    expect(r.text).toContain('client-rendered content')
  }, 30_000)
})
