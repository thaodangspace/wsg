import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrlText, htmlToText, isTextContentType } from '../src/remote.ts';
import { UsageError } from '../src/errors.ts';
import { startHttpFixture } from './helpers/http-fixture.ts';

test('isTextContentType accepts text and structured text, rejects binaries', () => {
  assert.equal(isTextContentType('text/plain; charset=utf-8'), true);
  assert.equal(isTextContentType('text/html'), true);
  assert.equal(isTextContentType('application/json'), true);
  assert.equal(isTextContentType('application/ld+json'), true);
  assert.equal(isTextContentType('application/xml'), true);
  assert.equal(isTextContentType(''), true);
  assert.equal(isTextContentType('image/png'), false);
  assert.equal(isTextContentType('application/pdf'), false);
  assert.equal(isTextContentType('application/octet-stream'), false);
});

test('htmlToText removes scripts, styles, comments, and tags', () => {
  const html =
    '<html><head><style>.x{color:red}</style></head><body><!-- remark -->' +
    '<h1>Title</h1><script>alert(1)</script><p>Hello &amp; welcome</p></body></html>';
  const text = htmlToText(html);
  assert.doesNotMatch(text, /alert\(1\)/);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /remark/);
  assert.doesNotMatch(text, /<[^>]+>/);
  assert.match(text, /Title/);
  assert.match(text, /Hello & welcome/);
});

test('fetchUrlText snapshots accessible plain text', async () => {
  const server = await startHttpFixture();
  server.serve('/notes.md', '# Notes\nhello world\n', { 'content-type': 'text/markdown' });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/notes.md`);
    assert.equal(outcome.kind, 'text');
    if (outcome.kind === 'text') {
      assert.equal(outcome.content.toString('utf8'), '# Notes\nhello world\n');
      assert.equal(outcome.truncated, false);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText converts HTML to text', async () => {
  const server = await startHttpFixture();
  server.serve('/page', '<h1>Docs</h1><script>evil()</script><p>Body text</p>', {
    'content-type': 'text/html',
  });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/page`);
    assert.equal(outcome.kind, 'text');
    if (outcome.kind === 'text') {
      assert.match(outcome.content.toString('utf8'), /Body text/);
      assert.doesNotMatch(outcome.content.toString('utf8'), /evil/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText falls back to a reference on non-text content types', async () => {
  const server = await startHttpFixture();
  server.serve('/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
    'content-type': 'image/png',
  });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/image.png`);
    assert.equal(outcome.kind, 'reference');
    if (outcome.kind === 'reference') {
      assert.match(outcome.reason, /unsupported content type/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText falls back to a reference on non-2xx status', async () => {
  const server = await startHttpFixture();
  server.serve('/missing', 'nope', { 'content-type': 'text/plain' }, 404);
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/missing`);
    assert.equal(outcome.kind, 'reference');
    if (outcome.kind === 'reference') {
      assert.match(outcome.reason, /HTTP 404/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText follows redirects and reports the final URL', async () => {
  const server = await startHttpFixture();
  server.set('/start', (_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', '/final');
    res.end();
  });
  server.serve('/final', 'arrived', { 'content-type': 'text/plain' });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/start`);
    assert.equal(outcome.kind, 'text');
    if (outcome.kind === 'text') {
      assert.equal(outcome.content.toString('utf8'), 'arrived');
      assert.match(outcome.finalUrl, /\/final$/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText stops after the redirect limit', async () => {
  const server = await startHttpFixture();
  server.set('/loop', (_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', '/loop');
    res.end();
  });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/loop`, { maxRedirects: 2 });
    assert.equal(outcome.kind, 'reference');
    if (outcome.kind === 'reference') {
      assert.match(outcome.reason, /too many redirects/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText truncates at the byte limit', async () => {
  const server = await startHttpFixture();
  server.serve('/big', 'x'.repeat(1000), { 'content-type': 'text/plain' });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/big`, { maxBytes: 10 });
    assert.equal(outcome.kind, 'text');
    if (outcome.kind === 'text') {
      assert.equal(outcome.content.length, 10);
      assert.equal(outcome.truncated, true);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText times out and returns a reference', async () => {
  const server = await startHttpFixture();
  server.set('/slow', (_req, res) => {
    setTimeout(() => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('late');
    }, 500);
  });
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/slow`, { timeoutMs: 30 });
    assert.equal(outcome.kind, 'reference');
    if (outcome.kind === 'reference') {
      assert.match(outcome.reason, /timed out/);
    }
  } finally {
    await server.close();
  }
});

test('fetchUrlText returns a reference for a network error', async () => {
  const outcome = await fetchUrlText('http://127.0.0.1:1/unreachable', { timeoutMs: 200 });
  assert.equal(outcome.kind, 'reference');
  if (outcome.kind === 'reference') {
    assert.match(outcome.reason, /fetch failed/);
  }
});

test('fetchUrlText rejects non-http(s) URLs before any network call', async () => {
  await assert.rejects(
    () => fetchUrlText('file:///etc/passwd'),
    (err: unknown) => err instanceof UsageError && /unsupported protocol/.test(err.message)
  );
  await assert.rejects(
    () => fetchUrlText('not a url'),
    (err: unknown) => err instanceof UsageError && /not a valid absolute URL/.test(err.message)
  );
});

test('fetchUrlText never returns private-key content as text', async () => {
  const server = await startHttpFixture();
  server.serve(
    '/key',
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    { 'content-type': 'text/plain' }
  );
  try {
    const outcome = await fetchUrlText(`${server.baseUrl}/key`);
    assert.equal(outcome.kind, 'reference');
  } finally {
    await server.close();
  }
});
