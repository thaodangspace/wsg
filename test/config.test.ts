import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  resolveSettings,
  getDefaultSettings,
  getConfigPath,
  ConfigSchema,
} from '../src/config.ts';
import { UsageError } from '../src/errors.ts';
import { parseYamlStrict } from '../src/yamlio.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'config');

test('missing config file returns defaults', () => {
  const missingPath = path.join(fixturesDir, 'non-existent-config.yaml');
  const settings = loadConfig({ WSG_CONFIG: missingPath });
  const defaults = getDefaultSettings();

  assert.deepEqual(settings, defaults);
  assert.equal(settings.workspace_root, path.join(os.homedir(), 'wsg'));
  assert.deepEqual(settings.code_roots, [path.join(os.homedir(), 'code')]);
  assert.deepEqual(settings.adapters, ['agents']);
  assert.equal(settings.max_discovered_repos, 5);
  assert.equal(settings.scout.provider, 'openai');
});

test('unknown key throws UsageError with key name and line:col', () => {
  const fixturePath = path.join(fixturesDir, 'unknown-key.yaml');
  assert.throws(
    () => loadConfig({ WSG_CONFIG: fixturePath }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /unknown_field/);
      assert.match(err.message, /3:1/);
      return true;
    }
  );
});

test('duplicate key is rejected with UsageError and line:col', () => {
  const fixturePath = path.join(fixturesDir, 'duplicate-key.yaml');
  assert.throws(
    () => loadConfig({ WSG_CONFIG: fixturePath }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /duplicate key|unique/i);
      assert.match(err.message, /\d+:\d+/);
      return true;
    }
  );
});

test('tilde ~ is expanded in paths', () => {
  const fixturePath = path.join(fixturesDir, 'tilde.yaml');
  const settings = loadConfig({ WSG_CONFIG: fixturePath });

  assert.equal(settings.workspace_root, path.join(os.homedir(), 'my-wsg'));
  assert.deepEqual(settings.code_roots, [path.join(os.homedir(), 'my-code')]);
  assert(!settings.workspace_root.startsWith('~'));
  assert(!settings.code_roots[0].startsWith('~'));
});

test('CLI --root overrides workspace_root', () => {
  const fixturePath = path.join(fixturesDir, 'tilde.yaml');

  const settingsWithRoot = loadConfig(
    { WSG_CONFIG: fixturePath },
    { root: '/custom/override/path' }
  );
  assert.equal(settingsWithRoot.workspace_root, '/custom/override/path');

  const settingsWithDashedRoot = loadConfig(
    { WSG_CONFIG: fixturePath },
    { '--root': '~/custom/tilde' }
  );
  assert.equal(
    settingsWithDashedRoot.workspace_root,
    path.join(os.homedir(), 'custom/tilde')
  );

  const direct = resolveSettings(
    { root: '/cli/root' },
    { workspace_root: '~/config/root' }
  );
  assert.equal(direct.workspace_root, '/cli/root');
});

test('api_key is rejected as unknown with UsageError and line:col', () => {
  const fixturePath = path.join(fixturesDir, 'api-key.yaml');
  assert.throws(
    () => loadConfig({ WSG_CONFIG: fixturePath }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /api_key/);
      assert.match(err.message, /4:1/);
      return true;
    }
  );
});

test('valid config file loads successfully with all options', () => {
  const fixturePath = path.join(fixturesDir, 'valid.yaml');
  const settings = loadConfig({ WSG_CONFIG: fixturePath });

  assert.deepEqual(settings.code_roots, [
    path.join(os.homedir(), 'code'),
    path.join(os.homedir(), 'work'),
  ]);
  assert.equal(settings.workspace_root, path.join(os.homedir(), 'wsg'));
  assert.deepEqual(settings.adapters, ['agents', 'claude']);
  assert.equal(settings.max_discovered_repos, 10);
  assert.equal(settings.scout.provider, 'openai');
  assert.equal(settings.scout.model, 'gpt-4o');
});

test('precedence CLI > config > defaults', () => {
  const config = {
    code_roots: ['~/config-code'],
    workspace_root: '~/config-wsg',
    adapters: ['agents' as const],
    max_discovered_repos: 8,
    scout: { provider: 'custom-provider', model: 'custom-model' },
  };

  // CLI overrides code_roots and adapters
  const resolved = resolveSettings(
    {
      code_root: ['~/cli-code-1', '~/cli-code-2'],
      for: 'claude',
    },
    config
  );

  assert.deepEqual(resolved.code_roots, [
    path.join(os.homedir(), 'cli-code-1'),
    path.join(os.homedir(), 'cli-code-2'),
  ]);
  assert.equal(resolved.workspace_root, path.join(os.homedir(), 'config-wsg'));
  assert.deepEqual(resolved.adapters, ['claude']);
  assert.equal(resolved.max_discovered_repos, 8);
  assert.equal(resolved.scout.provider, 'custom-provider');
  assert.equal(resolved.scout.model, 'custom-model');

  // --for none produces empty adapters
  const resolvedNone = resolveSettings({ for: 'none' }, config);
  assert.deepEqual(resolvedNone.adapters, []);

  // invalid adapter throws UsageError
  assert.throws(
    () => resolveSettings({ for: 'invalid-adapter' }),
    UsageError
  );
});

test('getConfigPath resolves WSG_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(
    getConfigPath({ WSG_CONFIG: '/custom/path.yaml' }),
    '/custom/path.yaml'
  );

  assert.equal(
    getConfigPath({ XDG_CONFIG_HOME: '/custom/xdg' }),
    '/custom/xdg/wsg/config.yaml'
  );

  assert.equal(
    getConfigPath({}),
    path.join(os.homedir(), '.config', 'wsg', 'config.yaml')
  );
});
