"""在 backend 目录执行 python run.py。"""
import qrcode
import uvicorn

from app.config import get_settings
from app.lan import discover_ipv4


def main():
    settings = get_settings()
    ignored = []
    addresses, primary = discover_ipv4(settings.lan_host, ignored=ignored)
    for iface, ip in ignored:
        label = f'{ip} ({iface})' if iface else ip
        print(f'已忽略代理/虚拟网卡地址：{label}。若手机仍无法访问，请在 .env 设置 LAN_HOST')
    for ip in addresses:
        print(f'手机页 http://{ip}:{settings.port}/    调试台 http://{ip}:{settings.port}/debug')
    if primary:
        qr = qrcode.QRCode(border=2)
        qr.add_data(f'http://{primary}:{settings.port}/')
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    if not addresses:
        print(f'未发现局域网 IPv4，请检查热点连接。本机访问 http://localhost:{settings.port}/')
    print('若手机打不开：确认同一网络；在 macOS 防火墙中允许 Python 接受传入连接')
    print('手机连同一热点后扫码打开；定位/录音需要 HTTPS，见 README', flush=True)
    uvicorn.run('app.main:app', host='0.0.0.0', port=settings.port)


if __name__ == '__main__':
    main()
