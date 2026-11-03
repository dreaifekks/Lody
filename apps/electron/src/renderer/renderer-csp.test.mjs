import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rendererHtml = await readFile(new URL('./index.html', import.meta.url), 'utf8')
const devbarHtml = await readFile(new URL('./devbar.html', import.meta.url), 'utf8')
const prImageHtml = await readFile(new URL('./pr-image.html', import.meta.url), 'utf8')

function getDirectiveSources(html, name) {
  const content = html.match(
    /<meta\b(?=[^>]*\bhttp-equiv="Content-Security-Policy")[^>]*\bcontent="([^"]*)"/i
  )?.[1]
  assert.ok(content, 'renderer entry must define a Content-Security-Policy meta tag')

  const directive = content
    .split(';')
    .map((value) => value.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name)
  assert.ok(directive, `renderer CSP must define ${name}`)
  return directive.slice(1)
}

void test('renderer CSP lets a player read file resources, previewed bytes and inline audio', () => {
  const sources = getDirectiveSources(rendererHtml, 'media-src')
  for (const source of ['lody-resource:', 'blob:', 'data:']) assert.ok(sources.includes(source))
})

void test('every renderer entry may reach the LANs the shell bridges', () => {
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(getDirectiveSources(html, 'connect-src').includes('lody-hub:'))
  }
})

void test('every renderer entry may call the GitHub API for pull request details', () => {
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(getDirectiveSources(html, 'connect-src').includes('https://api.github.com'))
  }
})

void test('every renderer entry may fetch GitHub avatars into the avatar cache', () => {
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(
      getDirectiveSources(html, 'connect-src').includes('https://avatars.githubusercontent.com')
    )
  }
})

void test('the isolated PR image document can run its loader without broadening the main renderer', () => {
  const script = prImageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const digest = createHash('sha256').update(script).digest('base64')
  assert.ok(getDirectiveSources(prImageHtml, 'script-src').includes(`'sha256-${digest}'`))
  assert.deepEqual(getDirectiveSources(prImageHtml, 'img-src'), ['https:'])
  assert.ok(!getDirectiveSources(rendererHtml, 'img-src').includes('https:'))
})

void test('renderer entries allow exactly the current inline boot shell script', async () => {
  const { createBootShellScript } =
    await import('../../../../packages/components/src/lib/boot-shell-script.ts')
  const digest = createHash('sha256').update(createBootShellScript()).digest('base64')
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(html.includes('<!-- lody:boot-shell-head -->'))
    assert.ok(html.includes('<div id="root"><!-- lody:boot-shell --></div>'))
    assert.ok(getDirectiveSources(html, 'script-src').includes(`'sha256-${digest}'`))
  }
})
