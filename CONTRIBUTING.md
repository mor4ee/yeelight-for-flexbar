# Contributing

Thank you for helping improve Yeelight for Flexbar.

## Before opening an issue

- Confirm that LAN Control is enabled for the Yeelight device.
- Confirm that the device is reachable from the same local network.
- Search existing issues for the model name and observed behavior.
- Do not publish private IP addresses, Wi-Fi credentials, tokens, or complete
  packet captures containing unrelated network traffic.

## Development principles

- Runtime control must remain independent of Yeelight Cloud.
- Outbound methods must stay in the explicit Yeelight command allowlist.
- A Unit must represent one user task and select only compatible targets.
- Device state shown by the UI must come from confirmed `props` or `get_prop`
  data, never an invented optimistic value.
- Slow discovery and synchronization must not block plugin startup.
- Background lights remain separate logical targets using standard Units.

## Local checks

See the dependency layout in [README.md](README.md), then run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run validate
npm.cmd run build
npm.cmd run pack
```

Changes to protocol handling should include focused unit tests. Changes to
connection behavior should also cover disconnect or reconnect behavior.

## Pull requests

- Keep changes focused and explain the user-visible effect.
- Include the Yeelight model and firmware version for hardware-specific fixes.
- Update `CHANGELOG.md` for behavior visible to users.
- Confirm that no generated `dist/`, `.test-dist/`, or `.flexplugin` files are
  committed.
