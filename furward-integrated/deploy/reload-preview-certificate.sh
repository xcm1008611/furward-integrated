#!/bin/sh
set -eu
certificate=/var/lib/dzq-proxy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/8.147.109.174/8.147.109.174.crt
fingerprint_file=/var/lib/furward-preview-tls/certificate.sha256
fingerprint=$(sha256sum "$certificate" | cut -d ' ' -f 1)
if [ -f "$fingerprint_file" ] && [ "$(cat "$fingerprint_file")" = "$fingerprint" ]; then
    exit 0
fi
systemctl reload furward-preview-tls.service
printf '%s\n' "$fingerprint" > "$fingerprint_file"
