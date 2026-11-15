# Yeelight for Flexbar

Control compatible Yeelight lights from independent Flexbar controls without
using Yeelight Cloud.

## Controls

- On/Off
- Brightness with an optional configured range
- Color temperature
- Hue
- Saturation

Each control selects its own compatible device. Main and background lights are
shown as separate logical targets.

## Requirements

- Windows; FlexDesigner 2.2.3 is the verified baseline with a compatible Flexbar
- A Yeelight device that exposes **LAN Control**
- The computer and light on the same trusted IPv4 network

The plugin uses local UDP multicast discovery, the compatible loopback
Yeelight Station daemon when available, and direct LAN transports as fallback.
It does not require Internet access at runtime, does not use a Yeelight
account, and does not send telemetry.

## Setup

1. Enable **LAN Control** in the Yeelight app.
2. Open the plugin settings in FlexDesigner.
3. Select **Scan network**, or add the light's local IPv4 address manually.
4. Add the required Yeelight Units in FlexDesigner and select a compatible
   target in each Unit.

See [Installation and LAN setup](../docs/SETUP.md) for firewall, multicast, and
troubleshooting details.

## Compatibility notes

Available controls depend on the capabilities advertised by each model.
Models without LAN Control are not supported. Multicast discovery can be
blocked by guest Wi-Fi, VLAN, firewall, or client-isolation settings; manual
IPv4 registration is available as a fallback.
