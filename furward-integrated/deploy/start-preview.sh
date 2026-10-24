#!/bin/sh
# Run on the existing preview server after copying source and private config.
set -eu
cd /opt/furward-preview
test -f web/.env.production
chmod 600 web/.env.production
/opt/dzq-releases/20261016/caddy validate --config deploy/Caddyfile.preview --adapter caddyfile
install -d -o dzq-proxy -g dzq-proxy -m 700 /var/lib/furward-preview-tls
install -m 644 deploy/furward-preview-tls.service /etc/systemd/system/
install -m 644 deploy/furward-preview-certificate.service /etc/systemd/system/
install -m 644 deploy/furward-preview-certificate.timer /etc/systemd/system/
systemctl daemon-reload
docker compose -f deploy/compose.yml up -d --wait --wait-timeout 120
systemctl enable --now furward-preview-tls.service
systemctl enable --now furward-preview-certificate.timer
systemctl start furward-preview-certificate.service
curl --fail --silent --show-error --max-time 10 --resolve 8.147.109.174:8088:127.0.0.1 https://8.147.109.174:8088/api/demo/health
