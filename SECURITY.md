# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories. Do
not include access tokens, passwords, private media paths, or signed media URLs
in a public issue.

## Deployment expectations

Vidpick is intended to sit behind HTTPS and an independent access-control layer
such as Nginx Basic Authentication or an identity-aware proxy. Use a dedicated
OpenList account whose base path is restricted to the intended media directory.

Deletion is disabled by default. Enable it only after verifying the service
account scope, backup or recycle-bin behavior, and reverse-proxy protection.

Never commit `.env` files, OpenList tokens, password files, cookies, or runtime
state. The example deployment reads the OpenList token from a mode-0600 file.
