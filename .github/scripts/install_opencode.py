"""Install a checksum-pinned CLI into runner temp, never replace the user's CLI."""
import hashlib
import os
import platform
import tarfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = '1.16.2'
ASSETS = {
    ('Darwin', 'arm64'): ('opencode-darwin-arm64.zip', '01585ff4d15820bd3a878e4bc7cacfb1ea75e236d1fed8c2f5f3595edc8b7ab5'),
    ('Darwin', 'x86_64'): ('opencode-darwin-x64-baseline.zip', '5d88142ee097a8e76daf7da51e432d3cf74cae698a1946337076c30a91b7a01e'),
    ('Linux', 'aarch64'): ('opencode-linux-arm64.tar.gz', 'eb1d5876c70675cfda93c4a1c4385d727412fae73154f1f005d155626df5b559'),
    ('Linux', 'x86_64'): ('opencode-linux-x64-baseline.tar.gz', 'fe34b047e3d4e2f6d891f0d2d3b4f44837ef5271eecfd9b98951e53857da69e6'),
}


def main():
    asset, digest = ASSETS[(platform.system(), platform.machine())]
    target = Path(os.environ['RUNNER_TEMP']) / f'wsg-opencode-{VERSION}'
    target.mkdir(parents=True, exist_ok=True)
    archive = target / asset
    url = f'https://github.com/anomalyco/opencode/releases/download/v{VERSION}/{asset}'
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('OpenCode release checksum mismatch')
    archive.write_bytes(data)
    # Extract only the executable; never trust archive paths.
    if asset.endswith('.zip'):
        with zipfile.ZipFile(archive) as bundle:
            names = [n for n in bundle.namelist() if Path(n).name == 'opencode']
            if len(names) != 1:
                raise RuntimeError('Unexpected release archive')
            binary = bundle.read(names[0])
    else:
        with tarfile.open(archive) as bundle:
            entries = [m for m in bundle.getmembers() if m.isfile() and Path(m.name).name == 'opencode']
            if len(entries) != 1:
                raise RuntimeError('Unexpected release archive')
            binary = bundle.extractfile(entries[0]).read()
    executable = target / 'opencode'
    executable.write_bytes(binary)
    executable.chmod(0o755)
    with Path(os.environ['GITHUB_PATH']).open('a') as path:
        path.write(str(target) + '\n')


if __name__ == '__main__':
    main()
