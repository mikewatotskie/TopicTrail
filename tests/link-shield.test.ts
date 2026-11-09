import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

async function shield() {
  assert.ok(existsSync('src/core/services/link_shield.ts'), 'Link Shield is not implemented');
  return import('../src/core/services/link_shield');
}

test('recognized HTTPS source separates hostname recognition from unperformed reputation checks', async () => {
  const { evaluateUrl } = await shield();
  const result = evaluateUrl('https://en.wikipedia.org/wiki/Photosynthesis');
  assert.equal(result.status, 'recognized'); assert.equal(result.recognition, 'educational');
  assert.equal(result.connection, 'https'); assert.equal(result.reputation, 'not_checked');
  assert.equal(result.hostname, 'en.wikipedia.org'); assert.equal(result.canOpenInApp, true);
  assert.equal(result.canOpenExternal, true); assert.ok(result.warnings.length);
});

test('absolute URL canonicalization uses parsed hostname, default port, path and unreserved escapes', async () => {
  const { canonicalBookmarkUrl } = await shield();
  assert.equal(canonicalBookmarkUrl(' HTTPS://EN.WIKIPEDIA.ORG:443/wiki/../wiki/%7eLife?q=%61%2f#%7e '),
    'https://en.wikipedia.org/wiki/~Life?q=a%2F#~');
  assert.equal(canonicalBookmarkUrl('https://en.wikipedia.org./wiki/A'), 'https://en.wikipedia.org/wiki/A');
});

test('canonical IDs preserve destination-sensitive path, query ordering and fragments', async () => {
  const { canonicalBookmarkUrl } = await shield();
  const urls = ['https://example.com/A', 'https://example.com/a', 'https://example.com/A/',
    'https://example.com/A?a=1&b=2', 'https://example.com/A?b=2&a=1', 'https://example.com/A#one', 'https://example.com/A#two'];
  assert.equal(new Set(urls.map(canonicalBookmarkUrl)).size, urls.length);
  assert.notEqual(canonicalBookmarkUrl('https://example.com/?q=a+b'), canonicalBookmarkUrl('https://example.com/?q=a%20b'));
});

test('unsupported schemes, relative URLs and deceptive slash forms never open', async () => {
  const { evaluateUrl } = await shield();
  for (const url of ['http://en.wikipedia.org/wiki/A', 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd',
    'content://local/file', 'intent://page', 'tel:123', 'mailto:a@example.com', '//en.wikipedia.org/wiki/A',
    '/wiki/A', 'https:en.wikipedia.org', 'https:///en.wikipedia.org', 'https:\\en.wikipedia.org']) {
    const result = evaluateUrl(url);
    assert.equal(result.canOpenInApp, false, url); assert.equal(result.canOpenExternal, false, url);
  }
});

test('userinfo including empty credentials and unexpected ports is blocked', async () => {
  const { evaluateUrl } = await shield();
  for (const url of ['https://student:password@en.wikipedia.org/wiki/A', 'https://@en.wikipedia.org',
    'https://en.wikipedia.org@evil.example.com', 'https://en.wikipedia.org:8443/', 'https://en.wikipedia.org:0/']) {
    assert.equal(evaluateUrl(url).status, 'blocked', url);
  }
  assert.equal(evaluateUrl('https://en.wikipedia.org:443/').status, 'recognized');
});

test('malformed authorities, labels, whitespace, escapes and control characters are blocked', async () => {
  const { evaluateUrl } = await shield();
  for (const url of ['https://', 'https://-bad.example.com', 'https://a..example.com', 'https://a_b.example.com',
    'https://en.wikipedia.org../', 'https://en.wiki\npedia.org', 'https://en.wikipedia.org/a b',
    'https://en.wikipedia.org/%0Asecret', 'https://en.wikipedia.org/%5csecret', 'https://en.wikipedia.org/%zz',
    'https://en.wikipedia.org/\u202Eevil', 'https://'+ 'a'.repeat(64)+'.com/']) {
    assert.equal(evaluateUrl(url).status, 'blocked', JSON.stringify(url));
  }
});

test('missing or non-string URLs cannot be verified and never trigger object coercion', async () => {
  const { evaluateUrl } = await shield();
  for (const url of [null, undefined, '', '   ', 12, { toString() { throw new Error('should not run'); } }]) {
    assert.equal(evaluateUrl(url).status, 'unable_to_verify');
    assert.equal(evaluateUrl(url).canOpenExternal, false);
  }
});

test('exact configured domain matching never recognizes suffix, prefix or arbitrary subdomain lookalikes', async () => {
  const { evaluateUrl } = await shield();
  for (const host of ['en.wikipedia.org.attacker.com', 'wikipedia.org.evil.com', 'notwikipedia.org',
    'en-wikipedia.org', 'arbitrary.en.wikipedia.org', 'developer.mozilla.org.attacker.com']) {
    const result = evaluateUrl('https://'+host+'/');
    assert.equal(result.recognition, 'unknown', host); assert.equal(result.canOpenInApp, false, host);
  }
  assert.match(evaluateUrl('https://en.wikipedia.org.attacker.com/').warnings.join(' '), /resembles|contains/i);
});

test('unknown structurally valid HTTPS sources receive neutral external review', async () => {
  const { evaluateUrl } = await shield();
  const result = evaluateUrl('https://unfamiliar.example.com/article');
  assert.equal(result.status, 'unrecognized'); assert.equal(result.canOpenExternal, true);
  assert.equal(result.canOpenInApp, false); assert.equal(result.connection, 'https');
  assert.doesNotMatch(result.reasons.join(' '), /malicious|malware detected|safe site/i);
});

test('internationalized hostnames stay unknown and include an honest display caution', async () => {
  const { evaluateUrl } = await shield();
  const result = evaluateUrl('https://wikipédiа.org/');
  assert.equal(result.status, 'unrecognized'); assert.match(result.hostname!, /xn--/);
  assert.match(result.warnings.join(' '), /international|lookalike/i);
});

test('local and private hostnames are blocked before navigation', async () => {
  const { evaluateUrl } = await shield();
  for (const host of ['localhost', 'LOCALHOST.', 'localhost.localdomain', 'school.localhost', 'printer',
    'router.local', 'lesson.internal', 'school.lan', 'router.home.arpa', '%6cocalhost']) {
    assert.equal(evaluateUrl('https://'+host+'/').status, 'blocked', host);
  }
});

test('all IP literals including parser-normalized alternate IPv4 forms are conservatively unsupported', async () => {
  const { evaluateUrl } = await shield();
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '0.0.0.0',
    '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '8.8.8.8', '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[2001:4860:4860::8888]']) {
    const result = evaluateUrl('https://'+host+'/');
    assert.equal(result.status, 'blocked', host); assert.equal(result.canOpenExternal, false, host);
  }
});

test('configured reference domain recognition is distinct from supported educational embedding', async () => {
  const { evaluateUrl } = await shield();
  const result = evaluateUrl('https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(result.status, 'recognized'); assert.equal(result.recognition, 'reference');
  assert.equal(result.canOpenInApp, false); assert.equal(result.canOpenExternal, true);
});

test('navigation permits only validated destinations in the initial configured provider group', async () => {
  const { decideNavigation } = await shield();
  const initial = 'https://en.wikipedia.org/wiki/Photosynthesis';
  assert.equal(decideNavigation(initial, 'https://en.wikipedia.org/wiki/Plant#leaf').action, 'allow');
  assert.equal(decideNavigation(initial, 'https://en.m.wikipedia.org/wiki/Plant').action, 'allow');
  assert.equal(decideNavigation(initial, 'https://developer.mozilla.org/en-US/').action, 'review');
  assert.equal(decideNavigation(initial, 'https://unknown.example.com/').action, 'review');
  assert.equal(decideNavigation(initial, 'http://en.wikipedia.org/').action, 'block');
  assert.equal(decideNavigation(initial, 'intent://external-app').action, 'block');
  assert.equal(decideNavigation(initial, 'https://127.0.0.1/').action, 'block');
});

test('an invalid or unknown initial URL never authorizes a navigation destination', async () => {
  const { decideNavigation } = await shield();
  for (const initial of ['javascript:alert(1)', 'https://unknown.example.com/']) {
    assert.equal(decideNavigation(initial, 'https://en.wikipedia.org/wiki/A').action, 'block');
  }
});

test('normalized URLs are bounded and safe errors never echo URL credentials', async () => {
  const { evaluateUrl, canonicalBookmarkUrl } = await shield();
  assert.equal(canonicalBookmarkUrl('https://example.com/'+ 'a'.repeat(2100)), null);
  const result = evaluateUrl('https://student:private-password@en.wikipedia.org/');
  assert.equal(result.normalizedUrl, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-password|student/);
});
