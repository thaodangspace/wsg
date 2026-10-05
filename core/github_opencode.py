"""Durable, owner-gated OpenCode GitHub queue. State is independent of Actions checkouts.

A running turn is deliberately never replayed: an operator must inspect its session and
worktree before taking further action. Only generated/published turns are recoverable.
"""
import argparse
import fcntl
import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path
from urllib.parse import quote

from core.opencode_events import parse_events

class Deferred(RuntimeError):
    """An earlier event for this workspace needs to finish before this event runs."""


class UnsafeState(RuntimeError):
    """Manual reconciliation required; never retry publication automatically."""


VERSION = '1.16.2'
MODEL = 'opencode-go/deepseek-v4-flash'
MARKER = '<!-- oc-event:'


def command(args, cwd=None, env=None, *, input=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=input, text=True, capture_output=True)
    if result.returncode:
        # Never include stderr/stdout: git and gh may echo credential-bearing URLs.
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode})')
    return result.stdout.strip()


def gh(method, path, fields=None):
    args = ['gh', 'api', '-X', method, path]
    for key, value in (fields or {}).items():
        args += ['-f', f'{key}={value}']
    return json.loads(command(args))


def pages(path):
    """Use GitHub Link pagination via gh --paginate, not its default first page."""
    output = command(['gh', 'api', '--paginate', '--slurp', '-X', 'GET', path])
    return [value for page in json.loads(output) for value in page]


def api(repo):
    return f'/repos/{repo}'


def marker(row):
    return f'{MARKER}{row["kind"]}:{row["comment_id"]} -->'


def request(event, kind):
    if kind == 'workflow_dispatch':
        return None
    if kind not in ('issue_comment', 'pull_request_review_comment'):
        return None
    comment = event['comment']
    match = re.fullmatch(r'/(?:oc|opencode)(?:\s+(.*))?', comment['body'].strip(), re.S)
    if not match:
        return None
    number = int((event.get('issue') or event.get('pull_request'))['number'])
    is_pr = kind == 'pull_request_review_comment' or 'pull_request' in event.get('issue', {})
    detail = (match.group(1) or '').strip()
    mode = 'pr' if is_pr else ('implement' if re.match(r'^implement(?:\s|$)', detail) else 'qa')
    if mode == 'implement':
        detail = detail[len('implement'):].strip()
    elif mode == 'qa' and re.match(r'^ask(?:\s|$)', detail):
        detail = detail[len('ask'):].strip()
    fresh = bool(mode == 'implement' and re.match(r'^--new(?:\s|$)', detail))
    if fresh:
        detail = detail[5:].strip()
    if kind == 'pull_request_review_comment':
        detail += '\nInline review context: ' + json.dumps({k: comment.get(k) for k in
            ('path', 'line', 'original_line', 'diff_hunk', 'commit_id', 'in_reply_to_id')})
    return str(comment['id']), number, mode, fresh, detail


def connect(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(state / 'queue.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('pragma busy_timeout=30000')
    db.execute('pragma journal_mode=WAL')
    db.executescript('''
        create table if not exists queue (
          seq integer primary key autoincrement, kind text not null, comment_id text not null,
          number integer not null, mode text not null, fresh integer not null, detail text not null,
          status text not null default 'pending', session text, branch text, work text,
          base text, base_ref text, head text, remote_branch text,
          result text, commit_sha text, pr_number integer, error text,
          unique(kind, comment_id));
        create table if not exists mapping (
          key text primary key, session text not null, branch text not null, work text not null,
          pr_number integer, remote_branch text);
    ''')
    # Preserve mappings created by early deployments of this orchestrator.
    if 'remote_branch' not in {x[1] for x in db.execute('pragma table_info(mapping)')}:
        db.execute('alter table mapping add column remote_branch text')
        db.execute('update mapping set remote_branch=branch')
        db.commit()
    return db


def enqueue(db, event, kind, repository, actor):
    if actor != repository.split('/')[0]:
        raise PermissionError('only repository owner may invoke')
    item = request(event, kind)
    if item is None:
        return None
    if event['comment']['user']['login'] != actor:
        raise PermissionError('comment author must be repository owner')
    cid, number, mode, fresh, detail = item
    with db:
        db.execute('insert or ignore into queue (kind,comment_id,number,mode,fresh,detail) values (?,?,?,?,?,?)',
                   (kind, cid, number, mode, int(fresh), detail))
    return db.execute('select seq from queue where kind=? and comment_id=?', (kind, cid)).fetchone()[0]


def update(db, seq, **values):
    with db:
        db.execute('update queue set ' + ', '.join(f'{key}=?' for key in values) + ' where seq=?',
                   (*values.values(), seq))


def mapping(db, key):
    return db.execute('select * from mapping where key=?', (key,)).fetchone()


def map_session(db, key, row, pr_number=None):
    with db:
        db.execute('insert or replace into mapping (key,session,branch,work,pr_number,remote_branch) values (?,?,?,?,?,?)',
                   (key, row['session'], row['branch'], row['work'], pr_number,
                    row['remote_branch'] or row['branch']))


def git_env(state):
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if not token:
        raise RuntimeError('GitHub token required for git HTTPS')
    script = state / 'askpass'
    # No token on disk or command line. Explicitly suppress machine-level helpers.
    if not script.exists():
        script.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "x-access-token\\n";; *) printf "%s\\n" "$OC_GIT_TOKEN";; esac\n')
        script.chmod(0o700)
    return {**os.environ, 'OC_GIT_TOKEN': token, 'GIT_ASKPASS': str(script),
            'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '2',
            'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '',
            'GIT_CONFIG_KEY_1': 'core.hooksPath', 'GIT_CONFIG_VALUE_1': '/dev/null'}


class Git:
    def __init__(self, state, repo):
        self.state = state
        self.repo = repo
        self.bare = state / 'repo.git'
        self.url = f'https://github.com/{repo}.git'

    def run(self, *args, cwd=None):
        return command(['git', *args], cwd, git_env(self.state))

    def setup(self):
        if not self.bare.exists():
            self.run('clone', '--bare', self.url, str(self.bare))
        if self.run('--git-dir', str(self.bare), 'remote', 'get-url', 'origin') != self.url:
            raise RuntimeError('state bare repository origin mismatch')
        self.run('--git-dir', str(self.bare), 'config', 'remote.origin.fetch',
                 '+refs/heads/*:refs/remotes/origin/*')

    def fetch(self, branch):
        self.run('--git-dir', str(self.bare), 'fetch', '--no-tags', 'origin',
                 f'+refs/heads/{branch}:refs/remotes/origin/{branch}')
        return self.run('--git-dir', str(self.bare), 'rev-parse', f'refs/remotes/origin/{branch}')

    def remote(self, branch):
        lines = self.run('--git-dir', str(self.bare), 'ls-remote', '--heads', 'origin',
                         f'refs/heads/{branch}')
        return lines.split()[0] if lines else None

    def at(self, work, *args):
        return self.run('-C', str(work), *args)

    def head(self, work):
        return self.at(work, 'rev-parse', 'HEAD')

    def check(self, row, clean=True):
        work = Path(row['work'])
        if not work.is_dir() or self.at(work, 'rev-parse', '--is-inside-work-tree') != 'true':
            raise UnsafeState('missing worktree')
        if Path(self.at(work, 'rev-parse', '--git-common-dir')).resolve() != self.bare.resolve():
            raise UnsafeState('worktree does not belong to state bare clone')
        try:
            branch = self.at(work, 'symbolic-ref', '--quiet', '--short', 'HEAD')
        except RuntimeError as exc:
            raise UnsafeState('worktree branch identity mismatch') from exc
        if branch != row['branch']:
            raise UnsafeState('worktree branch identity mismatch')
        if clean and self.at(work, 'status', '--porcelain'):
            raise UnsafeState('dirty worktree')
        return work

    def create(self, branch, work, base):
        if work.exists():
            raise RuntimeError('unexpected existing worktree')
        work.parent.mkdir(parents=True, exist_ok=True)
        self.run('--git-dir', str(self.bare), 'worktree', 'add', '-b', branch, str(work), base)

    def publish(self, row):
        work = self.check(row, clean=False)
        head = self.head(work)
        if not row['commit_sha']:
            if head != row['head']:
                # Commit may have succeeded immediately before a crash. Only recognize
                # the exact one-parent commit created by this event.
                if (self.at(work, 'rev-list', '--parents', '-n', '1', head) != f'{head} {row["head"]}' or
                    self.at(work, 'log', '-1', '--format=%s') != f'OpenCode event {row["seq"]}'):
                    raise UnsafeState('unrecognized local commit')
                if self.at(work, 'status', '--porcelain'):
                    raise UnsafeState('dirty after commit')
            elif self.at(work, 'status', '--porcelain'):
                self.at(work, 'add', '-A')
                self.at(work, 'commit', '-m', f'OpenCode event {row["seq"]}')
                head = self.head(work)
            update(row['db'], row['seq'], commit_sha=head)
        elif head != row['commit_sha'] or self.at(work, 'status', '--porcelain'):
            raise UnsafeState('published worktree changed')
        if row['mode'] == 'implement' and head == row['head']:
            raise UnsafeState('implementation made no code changes; no PR created')
        dest = row['remote_branch']
        expected = row['base'] if row['mode'] == 'pr' else None
        remote = self.remote(dest)
        if remote != expected and remote != head:
            raise UnsafeState('remote head moved; manual reconciliation required')
        if remote != head:
            self.at(work, 'push', 'origin', f'HEAD:refs/heads/{dest}')
        if self.remote(dest) != head:
            raise RuntimeError('push did not publish expected head')


def model_env(qa=False):
    allowed = {'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
               'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENCODE_API_KEY',
               'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'}
    env = {key: value for key, value in os.environ.items()
           if key in allowed or key.startswith(('XDG_', 'LC_'))}
    if os.environ.get('OC_MODEL_HOME'):
        env['HOME'] = os.environ['OC_MODEL_HOME']
    # Shell is denied even for implementation: all git operations are orchestrator owned.
    permission = {'*': 'deny', 'read': 'allow', 'glob': 'allow', 'grep': 'allow',
                  'list': 'allow', 'edit': 'allow', 'write': 'allow',
                  'apply_patch': 'allow', 'multiedit': 'allow', 'bash': 'deny'}
    if qa:
        permission = {'*': 'deny', 'read': 'allow', 'glob': 'allow',
                      'grep': 'allow', 'list': 'allow'}
    env['OPENCODE_DISABLE_PROJECT_CONFIG'] = '1'
    env['OPENCODE_CONFIG_CONTENT'] = json.dumps({'permission': permission, 'plugin': [], 'mcp': {}, 'share': 'disabled'})
    env['OPENCODE_PERMISSION'] = json.dumps(permission)
    return env


class TurnFailure(RuntimeError):
    def __init__(self, reason, session=None):
        super().__init__(reason)
        self.session = session


def invoke(work, prompt, session=None, qa=False):
    env = model_env(qa)
    if session:
        # --session may create missing sessions in some releases. Export first, fail closed.
        try:
            exported = json.loads(command(['opencode', 'export', session, '--pure'], work, env))
            if not isinstance(exported, dict) or exported.get('info', {}).get('id', exported.get('id')) != session:
                raise ValueError('session identity mismatch')
        except (RuntimeError, ValueError, KeyError) as exc:
            raise TurnFailure('existing OpenCode session missing or invalid') from exc
    # 1.16.2 exposes --pure (no external plugins) and --session only for resume,
    # not preallocation; persist the first JSON sessionID even on failed turns.
    args = ['opencode', 'run', '--pure', '--format', 'json', '--model', MODEL, '--variant', 'high']
    if session:
        args += ['--session', session]
    result = subprocess.run(args + [prompt], cwd=work, env=env, text=True, capture_output=True)
    identity = None
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value.get('sessionID'), str):
                identity = value['sessionID']
                break
        except (ValueError, AttributeError):
            pass
    try:
        sid, text = parse_events(result.stdout, expected_session=session)
        if any(json.loads(line).get('type') == 'error' for line in result.stdout.splitlines()):
            raise ValueError('OpenCode emitted an error event')
        if result.returncode:
            raise ValueError('OpenCode returned nonzero exit status')
        return sid, text
    except ValueError as exc:
        raise TurnFailure(str(exc), identity or session) from exc


def bounded(text, limit=20000):
    encoded = text.encode('utf-8')
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode('utf-8', errors='ignore') + '\n[Context truncated]'


def context(repo, number, mode, detail):
    prefix = api(repo)
    if mode == 'pr':
        pr = gh('GET', f'{prefix}/pulls/{number}')
        if pr['state'] != 'open' or pr['head']['repo']['full_name'] != repo or pr['base']['repo']['full_name'] != repo:
            raise RuntimeError('closed or fork PR refused')
        source = pr
    else:
        source = gh('GET', f'{prefix}/issues/{number}')
    comments = pages(f'{prefix}/issues/{number}/comments?per_page=100')
    parts = [bounded(f'{mode} #{number}: {source["title"]}\n{source.get("body") or ""}', 12000),
             'Latest issue/PR comments: ' + bounded(json.dumps([{'user': x['user']['login'], 'body': x['body']}
                                                        for x in comments[-30:]])), bounded(detail, 12000)]
    if mode == 'pr':
        reviews = pages(f'{prefix}/pulls/{number}/comments?per_page=100')
        parts.append('Inline review threads: ' + bounded(json.dumps([{
            k: c.get(k) for k in ('id', 'in_reply_to_id', 'path', 'line', 'diff_hunk', 'body')}
            for c in reviews[-100:]])))
        parts.append('PR diff: ' + bounded(command(['gh', 'api', '-H', 'Accept: application/vnd.github.v3.diff',
                                            f'{prefix}/pulls/{number}']), 30000))
    return '\n\n'.join(parts)


def allocate(db, git, repo, row):
    """All allocation is committed before the first model invocation."""
    seq, number, mode = row['seq'], row['number'], row['mode']
    if mode == 'qa':
        key = f'qa:{number}'
        old = mapping(db, key)
        branch = old['branch'] if old else gh('GET', api(repo))['default_branch']
        work = old['work'] if old else str(git.state / 'qa' / f'issue-{number}')
        session = old['session'] if old else None
        base = git.fetch(branch)
        # QA never runs in an implementation worktree; a detached checkout is separate.
        if not Path(work).exists():
            Path(work).parent.mkdir(parents=True, exist_ok=True)
            git.run('--git-dir', str(git.bare), 'worktree', 'add', '--detach', work, base)
        else:
            if (Path(git.at(work, 'rev-parse', '--git-common-dir')).resolve() != git.bare.resolve() or
                    git.at(work, 'status', '--porcelain') or
                    git.at(work, 'rev-parse', '--abbrev-ref', 'HEAD') != 'HEAD'):
                raise RuntimeError('unsafe QA worktree')
            local = git.head(work)
            if git.at(work, 'merge-base', local, base) != local:
                raise RuntimeError('diverged QA checkout')
            if local != base:
                git.at(work, 'merge', '--ff-only', base)
        update(db, seq, work=work, branch=branch, base=base, base_ref=branch,
               head=git.head(work), session=session)
        return
    if mode == 'pr':
        pr = gh('GET', f'{api(repo)}/pulls/{number}')
        if pr['state'] != 'open' or pr['head']['repo']['full_name'] != repo or pr['base']['repo']['full_name'] != repo:
            raise RuntimeError('closed or fork PR refused')
        key = f'pr:{number}'
        old = mapping(db, key)
        remote_branch = pr['head']['ref']
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', remote_branch) or '..' in remote_branch or remote_branch.startswith('-'):
            raise RuntimeError('unsafe PR branch')
        branch = old['branch'] if old else f'oc/pr-{number}'
        if old and old['remote_branch'] != remote_branch:
            raise UnsafeState('mapped PR remote branch changed')
        unresolved = db.execute("select seq from queue where seq<? and remote_branch=? and mode!='qa' and status!='done' order by seq limit 1",
                                (seq, remote_branch)).fetchone()
        if unresolved:
            raise Deferred(f'event {unresolved[0]} must be reconciled first')
        work = old['work'] if old else str(git.state / 'worktrees' / f'pr-{number}')
        base = git.fetch(remote_branch)
        if not old:
            git.create(branch, Path(work), base)
        else:
            git.check({'work': work, 'branch': branch})
            # Local branch differs from remote ref for external PRs.
            local = git.head(work)
            if git.at(work, 'merge-base', local, base) != local:
                raise RuntimeError('diverged or unpublished local commits')
            if local != base:
                git.at(work, 'merge', '--ff-only', base)
        update(db, seq, session=old['session'] if old else None, branch=branch,
               work=work, base=base, base_ref=pr['base']['ref'],
               head=git.head(work), remote_branch=remote_branch)
        return
    # A fresh request always receives a distinct branch and session; older retries retain theirs.
    if not row['fresh']:
        for prior in db.execute("select distinct pr_number from queue where number=? and mode='implement' and pr_number is not null", (number,)):
            if gh('GET', f'{api(repo)}/pulls/{prior[0]}')['state'] == 'open':
                raise RuntimeError(f'issue has an open implementation PR #{prior[0]}; use its PR or /oc implement --new')
    for pending in db.execute("select seq from queue where number=? and mode='implement' and seq<? and status in ('pending','running','generated','published','blocked') and (status!='blocked' or work is not null)", (number, seq)):
        if not row['fresh']:
            raise RuntimeError(f'previous implementation event {pending[0]} not complete')
    base_branch = gh('GET', api(repo))['default_branch']
    base = git.fetch(base_branch)
    branch = f'oc/issue-{number}-{seq}'
    work = git.state / 'worktrees' / f'issue-{number}-{seq}'
    git.create(branch, work, base)
    update(db, seq, branch=branch, work=str(work), base=base,
           base_ref=base_branch, head=base, remote_branch=branch)


def comment_once(row, repo, text):
    path = f'{api(repo)}/issues/{row["pr_number"] or row["number"]}/comments'
    tag = marker(row)
    if not any(tag in x.get('body', '') for x in pages(path + '?per_page=100')):
        gh('POST', path, {'body': f'{bounded(text, 55000)}\n\n{tag}'})


def publish(db, git, repo, row):
    seq, number, mode = row['seq'], row['number'], row['mode']
    if mode == 'qa' and (git.at(row['work'], 'status', '--porcelain') or git.head(row['work']) != row['head']):
        raise UnsafeState('QA worktree modified; manual reconciliation required')
    if mode != 'qa':
        # Attach db transiently, not to persisted row.
        values = dict(row)
        values['db'] = db
        if mode == 'pr':
            pr = gh('GET', f'{api(repo)}/pulls/{number}')
            if (pr['state'] != 'open' or pr['head']['repo']['full_name'] != repo or
                    pr['base']['repo']['full_name'] != repo or
                    pr['head']['ref'] != row['remote_branch']):
                raise UnsafeState('PR closed, forked or branch changed')
        git.publish(values)
        row = db.execute('select * from queue where seq=?', (seq,)).fetchone()
        if mode == 'implement':
            prs = pages(f'{api(repo)}/pulls?head={repo.split("/")[0]}:{quote(row["branch"])}&state=all&per_page=100')
            if prs:
                pr = prs[0]
                if pr['state'] != 'open':
                    raise UnsafeState('implementation PR closed')
            else:
                pr = gh('POST', f'{api(repo)}/pulls', {'title': f'Implement #{number}',
                    'head': row['branch'], 'base': row['base_ref'],
                    'body': f'Closes #{number}\n\n{bounded(row["result"], 55000)}'})
            update(db, seq, pr_number=pr['number'])
            row = db.execute('select * from queue where seq=?', (seq,)).fetchone()
            map_session(db, f'pr:{pr["number"]}', row, pr['number'])
            map_session(db, f'issue:{number}', row, pr['number'])
        else:
            if not mapping(db, f'pr:{number}'):
                map_session(db, f'pr:{number}', row, number)
    update(db, seq, status='published')
    row = db.execute('select * from queue where seq=?', (seq,)).fetchone()
    if mode != 'implement':
        comment_once(row, repo, row['result'])
    if mode == 'qa' and row['session']:
        map_session(db, f'qa:{number}', row)
    update(db, seq, status='done')


def process(db, git, repo, row):
    seq = row['seq']
    if row['status'] == 'published':
        if row['mode'] != 'implement':
            comment_once(row, repo, row['result'])
        if row['mode'] == 'qa' and row['session']:
            map_session(db, f'qa:{row["number"]}', row)
        update(db, seq, status='done')
        return
    if row['status'] == 'generated':
        publish(db, git, repo, row)
        return
    if row['status'] != 'pending':
        return
    if row['mode'] in ('qa', 'pr'):
        unresolved = db.execute("select seq from queue where seq<? and number=? and mode=? and status!='done' and (status!='blocked' or work is not null) order by seq limit 1",
                                (seq, row['number'], row['mode'])).fetchone()
        if unresolved:
            raise Deferred(f'event {unresolved[0]} must be reconciled first')
    allocate(db, git, repo, row)
    row = db.execute('select * from queue where seq=?', (seq,)).fetchone()
    prompt = context(repo, row['number'], row['mode'], row['detail'])
    # Mark running before invoking, including on resumed sessions. No automatic retry.
    update(db, seq, status='running')
    try:
        sid, text = invoke(Path(row['work']), prompt, row['session'], row['mode'] == 'qa')
    except TurnFailure as exc:
        update(db, seq, status='blocked', session=exc.session or row['session'], error=str(exc))
        raise
    update(db, seq, session=sid, result=text, status='generated')
    if git.head(row['work']) != row['head']:
        raise UnsafeState('model changed HEAD; manual reconciliation required')
    row = db.execute('select * from queue where seq=?', (seq,)).fetchone()
    publish(db, git, repo, row)


def report_failure(row, repo, error):
    tag = f'<!-- oc-event-error:{row["kind"]}:{row["comment_id"]} -->'
    path = f'{api(repo)}/issues/{row["number"]}/comments'
    try:
        if not any(tag in value.get('body', '') for value in pages(path + '?per_page=100')):
            recovery = ('Publication will retry on a later drain; the model will not rerun.'
                        if row['status'] in ('generated', 'published') else
                        'This event is blocked. Inspect Actions logs/state before reconciling; the model will not automatically replay.')
            gh('POST', path, {'body': f'OpenCode event {row["seq"]}: {bounded(str(error), 1500)}\n\n{recovery}\n\n{tag}'})
    except Exception:
        # GitHub outages must not lose the durable original error.
        print(f'Could not post failure notice for event {row["seq"]}', flush=True)


def drain(db, git, repo, retry=None):
    # Any prior crash in a model invocation is unambiguously blocked.
    with db:
        db.execute("update queue set status='blocked', error='interrupted model turn; manual reconciliation required' where status='running'")
    if retry is not None:
        row = db.execute('select * from queue where seq=?', (retry,)).fetchone()
        if row is None or row['status'] not in ('generated', 'published'):
            raise ValueError('--retry requires a generated or published event seq')
        try:
            process(db, git, repo, row)
        except UnsafeState as exc:
            update(db, retry, status='blocked', error=str(exc)[:500])
            report_failure(db.execute('select * from queue where seq=?', (retry,)).fetchone(), repo, exc)
            raise
        return
    failures = []
    for row in db.execute("select * from queue where status in ('pending','generated','published') order by seq").fetchall():
        try:
            process(db, git, repo, row)
        except Deferred as exc:
            update(db, row['seq'], error=str(exc)[:500])
        except Exception as exc:
            current = db.execute('select status from queue where seq=?', (row['seq'],)).fetchone()[0]
            if current in ('pending', 'running') or isinstance(exc, UnsafeState):
                update(db, row['seq'], status='blocked', error=str(exc)[:500])
            else:
                update(db, row['seq'], error=str(exc)[:500])
            report_failure(db.execute('select * from queue where seq=?', (row['seq'],)).fetchone(), repo, exc)
            failures.append(f'event {row["seq"]}: {exc}')
    if failures:
        raise RuntimeError('; '.join(failures))


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--drain', action='store_true')
    parser.add_argument('--retry', type=int)
    args = parser.parse_args(argv)
    repo = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('invalid repository')
    root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    configured = os.environ.get('OC_STATE_DIR', '')
    if not configured or not Path(configured).expanduser().is_absolute():
        raise ValueError('OC_STATE_DIR must be an absolute persistent path')
    state = Path(configured).expanduser().resolve() / repo
    if state == root or root in state.parents or state in root.parents:
        raise ValueError('state must be outside checkout')
    os.umask(0o077)
    for name in ('DATA', 'CONFIG', 'CACHE', 'STATE'):
        directory = state / 'opencode' / name.lower()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.environ[f'XDG_{name}_HOME'] = str(directory)
    home = state / 'opencode' / 'home'
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['OC_MODEL_HOME'] = str(home)
    db = connect(state)
    try:
        if not args.drain and args.retry is None:
            event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
            enqueue(db, event, os.environ['GITHUB_EVENT_NAME'], repo, os.environ['GITHUB_ACTOR'])
        # Enqueue commits independently, before flock; competing jobs may append meanwhile.
        with (state / 'queue.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if command(['opencode', '--version']) != VERSION:
                raise RuntimeError(f'OpenCode {VERSION} required')
            git = Git(state, repo)
            git.setup()
            drain(db, git, repo, args.retry)
    finally:
        db.close()


if __name__ == '__main__':
    main()
