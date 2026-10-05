import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedNpmScript,
  parsePackageJsonScripts,
  discoverCommands,
  allocateWrapperBasename,
  renderWrapper,
  shellQuote,
  extractDocumentedCommandLines,
  parseDocumentedCommand,
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

test('parsePackageJsonScripts tolerates malformed, non-string, and empty values', () => {
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
  // Empty / whitespace-only values name no concrete runnable command.
  assert.deepEqual(parsePackageJsonScripts('{"scripts":{"test":"","lint":"   ","build":"\\n"}}'), {});
});

test('discoverCommands builds manifest-ready commands from a supported npm test script', () => {
  const result = discoverCommands([repo('new-platform')], {
    readPackageJson: () =>
      JSON.stringify({ scripts: { test: 'node --test', build: 'tsc -p .', postinstall: 'node install.js' } }),
    readReadme: () => null,
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
    readReadme: () => null,
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
  const result = discoverCommands([repo('empty')], { readPackageJson: () => null, readReadme: () => null });
  assert.deepEqual(result.missingTestRepos, ['empty']);
  assert.deepEqual(result.commands, []);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /No test command discovered for repository 'empty'/);
});

test('discoverCommands reports malformed package.json without throwing', () => {
  const result = discoverCommands([repo('broken')], { readPackageJson: () => '{ not json', readReadme: () => null });
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
    readReadme: () => null,
  });
  assert.equal(result.commands.length, 1);
  const cmd = result.commands[0]!;
  assert.equal(cmd.name, 'test-r');
  assert.ok(cmd.wrapper!.startsWith('scripts/'));
  assert.ok(!cmd.wrapper!.includes('..'));
});

test('discoverCommands ignores empty/whitespace npm test values and reports the gap', () => {
  const result = discoverCommands([repo('hollow')], {
    readPackageJson: () => JSON.stringify({ scripts: { test: '   ' } }),
    readReadme: () => null,
  });
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.missingTestRepos, ['hollow']);
  assert.ok(result.gaps.some((g) => /No test command discovered/.test(g)));
});

test('extractDocumentedCommandLines reads fenced blocks and inline code only', () => {
  const readme = [
    '# Repo',
    '',
    'Prose mentioning npm run deploy should be ignored.',
    '',
    '```sh',
    'npm run verify',
    '',
    'sh scripts/check.sh',
    '```',
    '',
    'Also run `npm test` from the repository root.',
  ].join('\n');
  const lines = extractDocumentedCommandLines(readme);
  assert.ok(lines.includes('npm run verify'));
  assert.ok(lines.includes('sh scripts/check.sh'));
  assert.ok(lines.includes('npm test'));
  assert.ok(!lines.some((line) => line.includes('deploy')));
});

test('parseDocumentedCommand accepts only fixed concrete command forms', () => {
  assert.deepEqual(parseDocumentedCommand('npm test'), {
    kind: 'npm',
    scriptName: 'test',
    argv: ['npm', 'run', 'test'],
    display: 'npm test',
  });
  assert.deepEqual(parseDocumentedCommand('npm run verify'), {
    kind: 'npm',
    scriptName: 'verify',
    argv: ['npm', 'run', 'verify'],
    display: 'npm run verify',
  });
  assert.deepEqual(parseDocumentedCommand('sh scripts/check.sh'), {
    kind: 'script',
    scriptPath: 'scripts/check.sh',
    argv: ['sh', 'scripts/check.sh'],
    display: 'sh scripts/check.sh',
  });
  assert.deepEqual(parseDocumentedCommand('bash bin/run.sh'), {
    kind: 'script',
    scriptPath: 'bin/run.sh',
    argv: ['bash', 'bin/run.sh'],
    display: 'bash bin/run.sh',
  });

  for (const line of [
    'npm run deploy',
    'npm run',
    'npm run verify && rm -rf /',
    'sh ../evil.sh',
    'sh /tmp/evil.sh',
    'sh scripts/check.sh; rm -rf /',
    'node scripts/check.js',
    'sh scripts/no-extension',
    'sh tools/run.sh extra-arg',
    'echo hello',
  ]) {
    assert.equal(parseDocumentedCommand(line), null, `${JSON.stringify(line)} must be rejected`);
  }
});

test('discoverCommands honors a documented npm run command only when the script exists and is non-empty', () => {
  const readme = ['## Validation', '', '```sh', 'npm run verify', '```', ''].join('\n');

  const withScript = discoverCommands([repo('docs-repo')], {
    readPackageJson: () => JSON.stringify({ scripts: {} }),
    readReadme: () => readme,
  });
  assert.equal(withScript.commands.length, 0);

  const withEmptyScript = discoverCommands([repo('docs-repo')], {
    readPackageJson: () => JSON.stringify({ scripts: { verify: '  ' } }),
    readReadme: () => readme,
  });
  assert.equal(withEmptyScript.commands.length, 0);
  assert.ok(
    withEmptyScript.gaps.some((g) => /no matching non-empty package.json script/.test(g)),
    JSON.stringify(withEmptyScript.gaps)
  );

  const withRealScript = discoverCommands([repo('docs-repo')], {
    readPackageJson: () => JSON.stringify({ scripts: { verify: 'node verify.js' } }),
    readReadme: () => readme,
  });
  const verify = withRealScript.commands.find((c) => c.name === 'verify-docs-repo');
  assert.ok(verify, JSON.stringify(withRealScript.commands));
  assert.deepEqual(verify.argv, ['npm', 'run', 'verify']);
  assert.match(verify.evidence!, /^README\.md: documented/);
  assert.equal(verify.wrapper, 'scripts/verify-docs-repo.sh');
});

test('discoverCommands dedupes a documented npm command already found in package.json', () => {
  const result = discoverCommands([repo('dupe-repo')], {
    readPackageJson: () => JSON.stringify({ scripts: { test: 'node --test' } }),
    readReadme: () =>
      ['```', 'npm test', '```', ''].join('\n'),
  });
  assert.equal(result.commands.filter((c) => c.name === 'test-dupe-repo').length, 1);
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
