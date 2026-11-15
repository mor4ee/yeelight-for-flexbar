# Security Policy

## Supported versions

The plugin has not yet reached its first public release. Security fixes are
currently applied only to the latest code on the default branch.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting or open a private Security
Advisory for this repository. Include:

- affected version or commit;
- Yeelight model and relevant network conditions;
- reproduction steps;
- expected impact;
- suggested mitigation, if known.

Do not include real Wi-Fi credentials, access tokens, or unrelated packet
captures.

## Security boundaries

The plugin is intentionally limited to local IPv4 communication. Manual
addresses are restricted to private, loopback, or link-local ranges, and
outbound Yeelight methods are validated against a closed allowlist.
