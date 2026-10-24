import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.lan import parse_ipv4, discover_ipv4
from app.main import create_app
from app.services.assistant import TOOL_TABLE
from test_assistant import assistant
from test_navigation import nav
from test_vision import make_monitor, feed


@pytest.mark.parametrize('configured', [False, True])
def test_public_config_and_debug(settings, configured):
    settings.amap_js_key = 'browser-key' if configured else ''
    settings.amap_security_code = 'browser-code' if configured else ''
    settings.amap_key = 'server-only-key'
    settings.deepseek_api_key = 'server-only-llm-key'
    settings.llm_enabled = configured
    settings.port = 8765
    with TestClient(create_app(settings)) as client:
        page = client.get('/debug')
        assert page.status_code == 200
        assert page.headers['content-type'].startswith('text/html')
        assert '/ws/app' in page.text and '/api/robot/stop' in page.text
        result = client.get('/api/config/public')
        data = result.json()['data']
        assert set(data) == {'version', 'mode', 'amap_js_key', 'amap_security_code', 'has_llm', 'obstacle_source', 'indoor_waypoints'}
        assert data['version'] == '0.6.0'
        assert data['amap_js_key'] == settings.amap_js_key
        assert data['amap_security_code'] == settings.amap_security_code
        assert data['has_llm'] is configured
        assert data['obstacle_source'] == 'mock'
        assert {'id': 'desk', 'name': '服务台'} in data['indoor_waypoints']
        assert 'server-only' not in result.text
        client.post('/api/mode', json={'mode': 'outdoor'})
        assert client.get('/api/config/public').json()['data']['mode'] == 'outdoor'
        health = client.get('/api/health').json()['data']
        assert health['lan_urls'] == ['http://192.168.10.2:8765/debug']
        assert health['version'] == data['version']


def test_debug_external_urls():
    html = (Path(__file__).resolve().parents[1] / 'app/static/debug.html').read_text()
    urls = re.findall(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', html, re.I)
    assert any('webapi.amap.com' in url for url in urls)
    for url in urls:
        if url.startswith(('http:', 'https:', '//')):
            assert urlsplit(url).hostname == 'webapi.amap.com'
    assert 'innerHTML' not in html


@pytest.mark.parametrize('output', [
    'inet 127.0.0.1 netmask 0xff000000\ninet 192.168.1.3 netmask 0xffffff00\ninet 10.0.0.2 netmask 0xffffff00',
    'inet 127.3.2.1/8 scope host lo\ninet 192.168.1.3/24 brd 192.168.1.255\ninet 10.0.0.2/24 scope global eth0',
    'inet addr:192.168.1.3 Bcast:192.168.1.255\ninet addr:10.0.0.2\ninet6 ::1\ninet 0.0.0.0\ninet 999.2.3.4',
])
def test_parse_ipv4(output):
    assert parse_ipv4(output) == ['10.0.0.2', '192.168.1.3']
    assert parse_ipv4('inet 127.0.0.1\ninet 127.2.3.4\ninet6 ::1') == []


def test_discovery_and_launcher(monkeypatch, capsys):
    import app.lan as lan
    import run
    monkeypatch.setattr(lan.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='inet 192.168.1.3\ninet 127.0.0.1'))
    monkeypatch.setattr(lan, 'udp_ipv4', lambda: '10.0.0.2')
    assert discover_ipv4() == (['10.0.0.2', '192.168.1.3'], '192.168.1.3')
    monkeypatch.setattr(run, 'get_settings', lambda: Settings(_env_file=None, port=8765))
    calls = []
    monkeypatch.setattr(run.uvicorn, 'run', lambda *a, **k: calls.append((a, k)))
    qr = []
    class QR:
        def __init__(self, **kwargs): pass
        def add_data(self, value): qr.append(value)
        def make(self, **kwargs): pass
        def print_ascii(self, **kwargs): qr.append('printed')
    monkeypatch.setattr(run.qrcode, 'QRCode', QR)
    run.main()
    output = capsys.readouterr().out
    assert 'http://192.168.1.3:8765/debug' in output
    assert 'http://10.0.0.2:8765/debug' in output
    assert '手机连同一热点后扫码打开；定位/录音需要 HTTPS，见 README' in output
    assert qr == ['http://192.168.1.3:8765/', 'printed']
    assert calls == [(('app.main:app',), {'host': '0.0.0.0', 'port': 8765})]


def test_discovery_unavailable(monkeypatch):
    import app.lan as lan
    def missing(*args, **kwargs):
        raise FileNotFoundError()
    monkeypatch.setattr(lan.subprocess, 'run', missing)
    monkeypatch.setattr(lan, 'udp_ipv4', lambda: None)
    assert discover_ipv4() == ([], None)


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', ['clear', 'stop', 'disabled', 'no_frame', 'llm_failure'])
async def test_scene_monitor_fallback(assistant, scenario):
    monitor, source = make_monitor(assistant.navigation)
    try:
        assistant.llm.available = scenario == 'llm_failure'
        if scenario == 'llm_failure':
            assistant.llm.describe_image = AsyncMock(side_effect=RuntimeError('不可用'))
        assistant.obstacle_hints = monitor.hints_text
        if scenario != 'no_frame':
            await feed(monitor, source, 'stop' if scenario == 'stop' else 'clear')
        if scenario == 'disabled':
            monitor._inference_ok = False
        if scenario == 'no_frame':
            assistant.gateway.snapshot = AsyncMock(return_value=None)
        _, reply = await assistant._scene(TOOL_TABLE['describe_scene'], {})
        if scenario in {'clear', 'llm_failure'}:
            assert monitor.enabled and not monitor.detections
            assert reply == '前方暂时没有检测到障碍物'
        elif scenario == 'stop':
            assert '检测到' in reply and '箱子' in reply
        else:
            assert '看不清' in reply
    finally:
        await monitor.close()


MAC_INTERFACES = '''lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
    inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
    inet 172.20.10.14 netmask 0xfffffff0 broadcast 172.20.10.15
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 9000
    inet 198.18.0.1 --> 198.18.0.1 netmask 0xfffffffc
'''


def test_hotspot_with_proxy(monkeypatch, capsys):
    import app.lan as lan
    import run
    monkeypatch.setattr(lan.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=MAC_INTERFACES))
    monkeypatch.setattr(lan, 'udp_ipv4', lambda: '198.18.0.1')
    assert lan.parse_interfaces(MAC_INTERFACES) == [('en0', '172.20.10.14')]
    assert parse_ipv4(MAC_INTERFACES) == ['172.20.10.14']
    assert lan.primary_ipv4() == '172.20.10.14'
    assert discover_ipv4() == (['172.20.10.14'], '172.20.10.14')
    monkeypatch.setattr(run, 'get_settings', lambda: Settings(_env_file=None))
    monkeypatch.setattr(run.uvicorn, 'run', lambda *a, **k: None)
    qr = []
    monkeypatch.setattr(run.qrcode, 'QRCode', lambda **k: SimpleNamespace(
        add_data=qr.append, make=lambda **k: None, print_ascii=lambda **k: None))
    run.main()
    output = capsys.readouterr().out
    assert '已忽略代理/虚拟网卡地址：198.18.0.1 (utun4)。若手机仍无法访问，请在 .env 设置 LAN_HOST' in output
    assert '若手机打不开：确认同一网络；在 macOS 防火墙中允许 Python 接受传入连接' in output
    assert qr == ['http://172.20.10.14:8000/']


def test_linux_interfaces():
    from app.lan import parse_interfaces
    output = '''1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536
    inet 127.0.0.1/8 scope host lo
2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500
    inet 192.168.1.3/24 brd 192.168.1.255 scope global eth0
3: wlan0: <BROADCAST,MULTICAST,UP> mtu 1500
    inet 10.0.0.2/24 scope global wlan0
4: veth123@if5: <BROADCAST,MULTICAST,UP> mtu 1500
    inet 10.0.0.3/24 scope global veth123
5: docker0: <BROADCAST,MULTICAST,UP> mtu 1500
    inet 172.17.0.1/16 scope global docker0
'''
    assert parse_interfaces(output) == [('eth0', '192.168.1.3'), ('wlan0', '10.0.0.2')]
    assert parse_ipv4(output) == ['10.0.0.2', '192.168.1.3']


@pytest.mark.parametrize('prefix', ['utun', 'tun', 'tap', 'wg', 'docker', 'br-', 'veth', 'llw', 'awdl'])
def test_virtual_private_route_excluded(monkeypatch, prefix):
    import app.lan as lan
    output = f'{prefix}0: flags=1 mtu 1500\n    inet 192.168.1.2\nen0: flags=1 mtu 1500\n    inet 10.0.0.2'
    monkeypatch.setattr(lan.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=output))
    monkeypatch.setattr(lan, 'udp_ipv4', lambda: '192.168.1.2')
    assert discover_ipv4() == (['10.0.0.2'], '10.0.0.2')


@pytest.mark.parametrize('ip', ['198.18.0.0', '198.19.255.255', '169.254.0.1', '169.254.255.255'])
def test_unusable_lan_ranges(ip):
    from app.lan import usable_ipv4
    assert not usable_ipv4(ip)


@pytest.mark.parametrize('addresses,route,expected', [
    (['172.20.10.14', '192.168.1.3'], '192.168.1.3', '172.20.10.14'),
    (['192.168.1.3', '10.0.0.2'], '10.0.0.2', '192.168.1.3'),
    (['10.0.0.2', '172.16.0.2'], '172.16.0.2', '10.0.0.2'),
    (['172.16.0.2', '8.8.8.8'], '8.8.8.8', '172.16.0.2'),
    (['192.168.1.2', '192.168.1.3'], '192.168.1.3', '192.168.1.3'),
    (['8.8.4.4', '8.8.8.8'], '8.8.8.8', '8.8.4.4'),
    ([], '8.8.8.8', None),
    ([], '10.0.0.2', '10.0.0.2'),
])
def test_lan_priority(monkeypatch, addresses, route, expected):
    import app.lan as lan
    monkeypatch.setattr(lan.subprocess, 'run', lambda *a, **k: SimpleNamespace(
        stdout='\n'.join(f'inet {ip}' for ip in addresses)))
    monkeypatch.setattr(lan, 'udp_ipv4', lambda: route)
    assert lan.primary_ipv4() == expected


def test_lan_host_skips_discovery(monkeypatch):
    import app.lan as lan
    import run
    def forbidden(*args, **kwargs):
        pytest.fail('手动配置不应探测网卡或路由')
    monkeypatch.setenv('LAN_HOST', '172.20.10.14')
    settings = Settings(_env_file=None)
    assert settings.lan_host == '172.20.10.14'
    monkeypatch.setattr(lan.subprocess, 'run', forbidden)
    monkeypatch.setattr(lan, 'udp_ipv4', forbidden)
    assert lan.primary_ipv4(settings.lan_host) == settings.lan_host
    assert lan.lan_urls(8765, settings.lan_host) == ['http://172.20.10.14:8765/debug']
    monkeypatch.setattr(run, 'get_settings', lambda: settings)
    monkeypatch.setattr(run.uvicorn, 'run', lambda *a, **k: None)
    qr = []
    monkeypatch.setattr(run.qrcode, 'QRCode', lambda **k: SimpleNamespace(
        add_data=qr.append, make=lambda **k: None, print_ascii=lambda **k: None))
    run.main()
    assert qr == ['http://172.20.10.14:8000/']
    monkeypatch.setattr('app.main.lan_urls', lan.lan_urls)
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/health').json()['data']['lan_urls'] == ['http://172.20.10.14:8000/debug']
