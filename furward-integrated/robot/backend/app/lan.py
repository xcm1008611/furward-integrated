"""标准库局域网地址发现，命令输出解析可独立测试。"""
import ipaddress
import re
import socket
import subprocess


# 网络测试保留段常被 Clash、Surge 的 TUN 或 fake-ip 占用，手机无法直连。
PROXY_NETWORK = ipaddress.IPv4Network('198.18.0.0/15')
# 链路本地地址不能作为正常局域网扫码入口。
LINK_LOCAL_NETWORK = ipaddress.IPv4Network('169.254.0.0/16')
VIRTUAL_PREFIXES = ('utun', 'tun', 'tap', 'wg', 'docker', 'br-', 'veth', 'llw', 'awdl')
PRIORITY_NETWORKS = tuple(map(ipaddress.IPv4Network, (
    '172.20.10.0/28', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12',
)))


def usable_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
        return not (address.is_loopback or address.is_unspecified or address.is_multicast
                    or address.is_reserved or address in PROXY_NETWORK or address in LINK_LOCAL_NETWORK)
    except ipaddress.AddressValueError:
        return False


def _interface_addresses(output: str) -> list[tuple[str, str]]:
    entries = set()
    iface = ''
    for line in output.splitlines():
        header = re.match(r'^\s*\d+:\s+([^\s:]+):', line)
        if header is None:
            header = re.match(r'^([^\s:]+):?\s+(?:flags[=:]|Link\s)', line)
        if header:
            iface = header.group(1).split('@', 1)[0]
        for ip in re.findall(r'\binet\s+(?:addr:)?(\d+\.\d+\.\d+\.\d+)', line):
            entries.add((iface, ip))
    return sorted(entries)


def parse_interfaces(output: str) -> list[tuple[str, str]]:
    return [(iface, ip) for iface, ip in _interface_addresses(output)
            if not iface.startswith(VIRTUAL_PREFIXES) and usable_ipv4(ip)]


def parse_ipv4(output: str) -> list[str]:
    return sorted({ip for _, ip in parse_interfaces(output)})


def udp_ipv4() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # UDP connect 只选择本机路由，不发送数据。
            sock.connect(('192.0.2.1', 9))
            return sock.getsockname()[0]
    except OSError:
        return None


def _priority(ip: str) -> int:
    address = ipaddress.IPv4Address(ip)
    return next((i for i, network in enumerate(PRIORITY_NETWORKS) if address in network),
                len(PRIORITY_NETWORKS))


def discover_ipv4(lan_host: str = '', *, ignored: list[tuple[str, str]] | None = None) -> tuple[list[str], str | None]:
    if lan_host:
        return [lan_host], lan_host
    addresses = set()
    excluded = set()
    for command in (['ifconfig'], ['/sbin/ifconfig'], ['ip', '-4', 'addr']):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=2, check=False)
            addresses.update(parse_ipv4(result.stdout))
            for iface, ip in _interface_addresses(result.stdout):
                try:
                    proxy = ipaddress.IPv4Address(ip) in PROXY_NETWORK
                except ipaddress.AddressValueError:
                    continue
                if iface.startswith(VIRTUAL_PREFIXES) or proxy:
                    excluded.add((iface, ip))
        except (OSError, subprocess.TimeoutExpired):
            continue
    route = udp_ipv4()
    # 只接受 RFC1918 私网，避免 is_private 将测试保留段等特殊地址也算作私网。
    if route and usable_ipv4(route) and _priority(route) < len(PRIORITY_NETWORKS) and route not in {ip for _, ip in excluded}:
        addresses.add(route)
    else:
        if route and usable_ipv4(route) is False:
            try:
                if ipaddress.IPv4Address(route) in PROXY_NETWORK and route not in {ip for _, ip in excluded}:
                    excluded.add(('', route))
            except ipaddress.AddressValueError:
                pass
        route = None
    if ignored is not None:
        ignored.extend(sorted(excluded))
    primary = min(addresses, key=lambda ip: (_priority(ip), ip != route, ip), default=None)
    return sorted(addresses), primary


def primary_ipv4(lan_host: str = '') -> str | None:
    return discover_ipv4(lan_host)[1]


def lan_urls(port: int, lan_host: str = '') -> list[str]:
    return [f'http://{ip}:{port}/debug' for ip in discover_ipv4(lan_host)[0]]
