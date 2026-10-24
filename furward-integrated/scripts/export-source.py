"""Create a source handoff without credentials, virtualenvs, caches or databases."""
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.next', '.runtime',
        'outputs', 'backups', '.DS_Store', '.taste-skill', '.admin-credentials', '.agents', '.codex'}


def include(path):
    rel = path.relative_to(ROOT)
    if any(part in SKIP for part in rel.parts):
        return False
    if rel.parts[:2] == ('web', 'data'):
        return False
    if path.name.startswith('.env') and path.name != '.env.example':
        return False
    if path.suffix in {'.pem', '.key', '.tsbuildinfo', '.sqlite', '.sqlite-shm', '.sqlite-wal', '.blend1', '.blend2'}:
        return False
    return path.name != 'next-env.d.ts'


def main():
    date = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d-%H%M%S')
    output = ROOT / 'outputs' / f'绒途Furward-完整整合源码-{date}.zip'
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(ROOT.rglob('*')):
            if path.is_file() and include(path):
                archive.write(path, Path('furward-integrated') / path.relative_to(ROOT))
    with ZipFile(output) as archive:
        assert archive.testzip() is None
        assert not any('/.env.production' in name or '/.runtime/' in name for name in archive.namelist())
    print(output)


if __name__ == '__main__':
    main()
