import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageError } from './errors.ts';
import type { CredentialStore, Credential } from '@earendil-works/pi-ai';

const execFileAsync = promisify(execFile);

/** Delegate refresh and cross-process locking to Pi's public auth CLI, never to WSG. */
export async function piCodexCredentials(
  command = 'pi',
  run: typeof execFileAsync = execFileAsync
): Promise<CredentialStore> {
  const fetchCredential = async (): Promise<Credential> => {
    try {
      const result = await run(command, ['auth', 'print-bearer-token', '--provider', 'openai-codex', '--min-expiry', '5m'], {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
      const token = result.stdout.trim();
      if (!token || token.includes('\n')) throw new Error('Invalid bearer token response');
      // Pi guarantees at least 5m validity. Keep a conservative in-memory expiry;
      // pi-ai will ask modify() for a fresh token before using it.
      return { type: 'oauth', access: token, refresh: '', expires: Date.now() + 240_000 };
    } catch {
      throw new UsageError('Pi Codex login unavailable. Run pi, then /login and select OpenAI Codex; ensure pi is on PATH.');
    }
  };
  let credential = await fetchCredential();
  return {
    async read(id) { return id === 'openai-codex' ? credential : undefined; },
    async list() { return [{ providerId: 'openai-codex', type: 'oauth' }]; },
    async modify(id) {
      if (id !== 'openai-codex') return undefined;
      // Pi CLI owns refresh and locking. Never invoke pi-ai's refresh callback,
      // which would require Pi's private refresh token or mutate its auth store.
      credential = await fetchCredential();
      return credential;
    },
    async delete() { throw new Error('WSG does not modify Pi credentials'); },
  };
}
