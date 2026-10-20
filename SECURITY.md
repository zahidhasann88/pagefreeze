# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Instead:

- Use GitHub's private reporting: _Security_ tab → _Report a vulnerability_, or
- Email jahidhasann67@gmail.com

Include steps to reproduce, the affected version, and the impact. We aim to reply within
3 business days.

Only the latest release receives security fixes.

## Secret key rotation

Changing `PAGEFREEZE_SECRET_KEY` makes stored secrets unreadable. To rotate it, set the new
key, then re-enter every monitor's headers/cookies and every webhook secret.

## Chromium sandbox

The Docker image sets `PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX=true` because unprivileged
containers can't run Chromium's sandbox; the container itself is the isolation boundary.
If your host supports unprivileged user namespaces, you can set it to `false`.
