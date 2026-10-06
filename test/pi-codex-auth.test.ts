import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piCodexCredentials } from '../src/pi-codex-auth.ts';
import { UsageError } from '../src/errors.ts';

test('Pi CLI supplies and refreshes an in-memory Codex credential', async () => {
  let args: string[] = [];
  let calls = 0;
  const store = await piCodexCredentials('pi', (async (_cmd: string, argv: string[]) => {
    args = argv;
    return { stdout: `test-token-${++calls}\n`, stderr: '' };
  }) as never);
  assert.deepEqual(args, ['auth', 'print-bearer-token', '--provider', 'openai-codex', '--min-expiry', '5m']);
  assert.equal((await store.read('openai-codex'))?.type, 'oauth');
  assert.equal((await store.read('openai-codex') as { access: string }).access, 'test-token-1');
  assert.equal(await store.read('openai'), undefined);
  const refreshed = await store.modify('openai-codex', async () => { throw new Error('must not refresh directly'); });
  assert.equal(refreshed?.type, 'oauth');
  assert.equal((refreshed as { access: string }).access, 'test-token-2');
  assert.equal((await store.read('openai-codex') as { access: string }).access, 'test-token-2');
  assert.equal(calls, 2);
  assert.equal(await store.modify('openai', async () => undefined), undefined);
});

test('missing Pi login produces an actionable error without leaking CLI stderr', async () => {
  await assert.rejects(
    () => piCodexCredentials('pi', (async () => { throw new Error('private token'); }) as never),
    (error: unknown) => error instanceof UsageError && /\/login/.test(error.message) && !/private token/.test(error.message)
  );
});
