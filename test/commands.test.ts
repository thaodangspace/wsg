import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedNpmScript,
  parsePackageJsonScripts,
  discoverCommands,
  allocateWrapperBasename,
  renderWrapper,
  shellQuote,
  type CommandRepoInput,
} from '../src/commands.ts';
import type { CommandEntry } from '../src/manifest.ts';

function repo(name: string, extra: Partial<CommandRepoInput> = {}): CommandRepoInput {
  return {
    name,
    source: `/code/${name}`,
    base_commit: 'a'.repeat(40),
    ...extra,
  };
}

test('isSupportedNpmScript accepts concrete validation scripts only', () => {
  for (const name of ['test', 'lint', 'typecheck', 'build', 'check', 'test:unit', 'test-integration']) {
    assert.equal(isSupportedNpmScript(name), true, `${name} should be supported`);
  }
  for (const name of [
    '',
    '-x',
    'postinstall',
    'prepare',
    'test x',
    '../evil',
    'test;rm -rf /',
    'test/../../evil',
    'test\0x',
  ]) {
    assert.equal(isSupportedNpmScript(name), false, `${JSON.stringify(name)} should be rejected`);
  }
});

test('parsePackageJsonScripts tolerates malformed and non-string entries', () => {
  assert.equal(parsePackageJsonScripts('{ not json'), null);
  assert.equal(parsePackageJsonScripts('[]'), null);
  assert.equal(parsePackageJsonScripts('null'), null);
  assert.deepEqual(parsePackageJsonScripts('{}'), {});
  assert.deepEqual(parsePackageJsonScripts('{"name":"x"}'), {});
  assert.deepEqual(
    parsePackageJsonScripts('{"scripts":{"test":"node --test","bad":42,"ok":"echo"}}'),
    { test: 'node --test', ok: 'echo' }
  );
  assert.deepEqual(parsePackageJsonScripts('{"scripts":[]}'), {});
});

test('discoverCommands builds manifest-ready commands from a supported npm test script', () => {
  const result = discoverCommands([repo('new-platform')], {
    readPackageJson: () =>
      JSON.stringify({ scripts: { test: 'node --test', build: 'tsc -p .', postinstall: 'node install.js' } }),
  });

  assert.deepEqual(result.missingTestRepos, []);
  assert.equal(result.commands.length, 2);

  const testCmd = result.commands.find((c) => c.name === 'test-new-platform');
  assert.ok(testCmd, `expected test-new-platform in ${result.commands.map((c) => c.name).join(', ')}`);
  assert.equal(testCmd.cwd, 'new-platform');
  assert.deepEqual(testCmd.argv, ['npm', 'run', 'test']);
  assert.equal(testCmd.evidence, 'package.json scripts.test');
  assert.equal(testCmd.wrapper, 'scripts/test-new-platform.sh');

  const buildCmd = result.commands.find((c) => c.name === 'build-new-platform');
  assert.ok(buildCmd);
  assert.deepEqual(buildCmd.argv, ['npm', 'run', 'build']);

  // postinstall is not a supported validation script and never becomes a command.
  assert.ok(!result.commands.some((c) => c.argv.join(' ').includes('postinstall')));
});

test('discoverCommands reports a missing-test gap and invents no wrapper', () => {
  const result = discoverCommands([repo('legacy')], {
    readPackageJson: () => JSON.stringify({ scripts: { build: 'tsc -p .' } }),
  });

  assert.deepEqual(result.missingTestRepos, ['legacy']);
  assert.equal(result.commands.length, 1);
  assert.ok(!result.commands.some((c) => c.name.includes('test')));
  assert.ok(
    result.gaps.some((g) => /No test command discovered for repository 'legacy'/.test(g)),
    `expected missing-test gap, got ${JSON.stringify(result.gaps)}`
  );
  assert.ok(
    result.gaps.some((g) => /no verification wrapper was generated/.test(g)),
    'gap must state that no wrapper was invented'
  );
});

test('discoverCommands reports a gap when package.json is absent', () => {
  const result = discoverCommands([repo('empty')], { readPackageJson: () => null });
  assert.deepEqual(result.missingTestRepos, ['empty']);
  assert.deepEqual(result.commands, []);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /No test command discovered for repository 'empty'/);
});

test('discoverCommands reports malformed package.json without throwing', () => {
  const result = discoverCommands([repo('broken')], { readPackageJson: () => '{ not json' });
  assert.deepEqual(result.commands, []);
  assert.ok(result.gaps.some((g) => /could not be parsed as JSON/.test(g)));
  assert.ok(result.gaps.some((g) => /No test command discovered/.test(g)));
});

test('discoverCommands ignores malicious script names without building wrappers', () => {
  const result = discoverCommands([repo('r')], {
    readPackageJson: () =>
      JSON.stringify({
        scripts: {
          '../../evil': 'rm -rf /',
          'test;rm -rf /': 'true',
          'test/../x': 'true',
          test: 'node --test',
        },
      }),
  });
  assert.equal(result.commands.length, 1);
  const cmd = result.commands[0]!;
  assert.equal(cmd.name, 'test-r');
  assert.ok(cmd.wrapper!.startsWith('scripts/'));
  assert.ok(!cmd.wrapper!.includes('..'));
});

test('allocateWrapperBasename avoids reserved/used basenames deterministically', () => {
  const used = new Set<string>(['test-repo.sh']);
  const first = allocateWrapperBasename('test', repo('repo'), used);
  assert.match(first, /^test-repo-[0-9a-f]{6}\.sh$/);
  assert.ok(used.has(first.toLowerCase()));

  // Same inputs against a fresh used-set allocate the same wrapper.
  const second = allocateWrapperBasename('test', repo('repo'), new Set(['test-repo.sh']));
  assert.equal(second, first);

  const free = allocateWrapperBasename('lint', repo('repo'), used);
  assert.equal(free, 'lint-repo.sh');
});

test('renderWrapper quotes argv, resolves cwd relative to itself, and propagates exit', () => {
  const command: CommandEntry = {
    name: 'test-repo',
    cwd: 'repo',
    argv: ['npm', 'run', 'test'],
    evidence: 'package.json scripts.test',
    wrapper: 'scripts/test-repo.sh',
  };
  const text = renderWrapper(command);
  assert.match(text, /^#!\/bin\/sh/);
  assert.match(text, /wsg_script_dir=.*dirname/);
  assert.ok(text.includes(`cd -- "$wsg_script_dir/.."/'repo'`), text);
  assert.match(text, /exec 'npm' 'run' 'test' -- "\$@"/);
  assert.match(text, /never verified or executed/);
});

test('renderWrapper neutralizes hostile cwd and evidence without shell injection', () => {
  const text = renderWrapper({
    name: 'evil',
    cwd: 'x$(touch /tmp/pwned)',
    argv: ['npm', 'run', 'test'],
    evidence: 'legit\nrm -rf /',
    wrapper: 'scripts/evil.sh',
  });
  // Hostile cwd stays inside single quotes.
  assert.ok(
    text.includes(`cd -- "$wsg_script_dir/.."/'x$(touch /tmp/pwned)'`),
    text
  );
  // Evidence cannot break out of the comment line.
  const lines = text.split('\n');
  assert.ok(!lines.some((line) => line.trim() === 'rm -rf /'), 'evidence must not inject a command line');
  assert.match(text, /# Generated by WSG from legit rm -rf \//);
});

test('shellQuote neutralizes shell metacharacters and single quotes', () => {
  assert.equal(shellQuote('plain'), `'plain'`);
  assert.equal(shellQuote('a b'), `'a b'`);
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
  assert.equal(shellQuote('$(rm -rf /)'), `'$(rm -rf /)'`);
});
