import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

import app.api.public as public
from app.main import create_app

STATIC = Path(__file__).resolve().parents[1] / 'app/static'


@pytest.mark.parametrize('path, needles', [
    ('/', ('/api/voice/text', '/api/robot/stop', '/ws/app', 'role="tablist"', 'aria-live', 'id="panelMap"')),
    ('/showcase', ('/api/voice/text', '/api/robot/stop', 'id="demo"', 'id="how"', 'id="team"')),
])
def test_pages_served(settings, path, needles):
    with TestClient(create_app(settings)) as client:
        page = client.get(path)
        assert page.status_code == 200
        assert page.headers['content-type'].startswith('text/html')
        for needle in needles:
            assert needle in page.text


@pytest.mark.parametrize('name', ['assist.html', 'showcase.html'])
def test_pages_no_external_urls_or_innerhtml(name):
    html = (STATIC / name).read_text(encoding='utf-8')
    assert 'innerHTML' not in html
    for url in re.findall(r'https?://[^\s\'"<>)]+', html):
        assert urlsplit(url).hostname == 'webapi.amap.com'


def test_assist_buttons_have_accessible_names():
    # 视障用户依赖读屏：每个按钮都要有可读文字或 aria 标签
    html = (STATIC / 'assist.html').read_text(encoding='utf-8')
    for tag in re.findall(r'<button[^>]*>.*?</button>', html, re.S):
        text = re.sub(r'<[^>]+>', '', tag).strip()
        assert text or 'aria-label' in tag, tag


def test_media_serves_files_and_rejects_others(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(public, 'MEDIA_DIR', tmp_path)
    (tmp_path / 'hero.jpg').write_bytes(b'\xff\xd8fake')
    (tmp_path / 'notes.txt').write_text('secret')
    with TestClient(create_app(settings)) as client:
        ok = client.get('/media/hero.jpg')
        assert ok.status_code == 200 and ok.headers['content-type'] == 'image/jpeg'
        assert client.head('/media/hero.jpg').status_code == 200
        assert client.get('/media/demo.mp4').status_code == 404
        assert client.get('/media/notes.txt').status_code == 404
        assert client.get('/media/..%2Fassist.html').status_code == 404
