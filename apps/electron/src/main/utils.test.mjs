import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeExternalUrl } from './utils.ts'

void test('opens web and Telegram links externally and refuses other schemes', () => {
  assert.equal(normalizeExternalUrl(' https://example.org/a '), 'https://example.org/a')
  assert.equal(
    normalizeExternalUrl('tg://privatepost?channel=1001&post=42'),
    'tg://privatepost?channel=1001&post=42'
  )
  assert.equal(normalizeExternalUrl('file:///etc/passwd'), null)
  assert.equal(normalizeExternalUrl('javascript:alert(1)'), null)
  assert.equal(normalizeExternalUrl(''), null)
  assert.equal(normalizeExternalUrl(42), null)
})
