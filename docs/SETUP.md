# Installation and LAN setup

Yeelight for Flexbar controls compatible lights directly over the local
network. Yeelight Cloud credentials are not used, and Internet access is not
required after the light has been configured.

## 1. Enable LAN Control

1. Add the light to the official Yeelight app and update its firmware if
   required.
2. Open the selected light's settings in the Yeelight app.
3. Enable **LAN Control**.
4. Keep the computer running FlexDesigner and the light on the same trusted
   IPv4 network.

The exact menu location and feature availability depend on the model,
firmware, and region. A model that does not expose LAN Control cannot be
controlled by this plugin.

## 2. Install the current FlexDesigner package

The current tested target is FlexDesigner 2.2.3 on Windows using Plugin API
v1. Build and validate the package from the repository:

```powershell
npm.cmd run build
npm.cmd run validate
npm.cmd run pack
```

Import the generated `.flexplugin` using FlexDesigner's plugin manager.
Keep the source checkout separate from your active device configuration.


## 3. Register lights

1. Open **App → Setting → Application → Yeelight** in FlexDesigner.
2. Select **Scan network**.
3. Wait for discovered main and background light targets to appear.
4. If multicast discovery is unavailable, enter the light's local IPv4
   address under **Manual addresses**, then select **Add**.

Discovery uses UDP multicast on `239.255.255.250:1982`. Control uses the local
Yeelight Station daemon when a compatible running instance is available.
Otherwise the plugin uses Yeelight LAN transports, including TCP port `55443`.
A firewall, guest Wi-Fi isolation, VLAN rule, or access-point client isolation
must not block this local traffic.

For a manually registered address, reserve the light's address in the router's
DHCP settings. Automatic discovery can follow an address change because the
plugin identifies a physical light by its Yeelight device ID.

## 4. Add controls to Flexbar

Add each required Yeelight Unit separately in FlexDesigner:

- **On/Off**
- **Brightness**
- **Color Temperature**
- **Hue**
- **Saturation**

Every Unit has its own device selector and shows only compatible logical
targets. A model with background lighting exposes the background light as a
separate target, so it uses the same standard Units.

Brightness can be limited to a configured minimum and maximum. The Unit still
uses its full physical width. If the minimum is `0%`, the far-left position
powers the light off; other positions map to the configured brightness range.
Color Temperature always uses the complete range reported by the selected
device.

FlexDesigner v1 only supports a single solid native slider-track color. Color
Temperature, Hue and Saturation therefore retain native sliders over static,
full-Unit semantic gradient backgrounds. Regenerate these deterministic PNG
assets after changing their drawing source with:

```powershell
node scripts/generate-v1-slider-backgrounds.mjs
```

On/Off uses the native state appearance editor. The orange arrows beside the
Unit preview select the first (off) or second (on) state. Configure each state's
background on Background and its icon on Foreground, then Apply Changes.
Choose the same icon in both states if desired. Function only selects the device.

## Troubleshooting

- **Nothing is found:** confirm LAN Control, same IPv4 network, and UDP
  multicast access; then try the manual IPv4 fallback.
- **A saved target is unavailable:** rescan after the light reconnects. The
  Unit binding is retained while the target is offline.
- **The address changed:** run discovery again. Use a DHCP reservation for a
  manual-only setup.
- **FlexDesigner was restarted:** wait a few seconds for Station topology or
  LAN discovery to rehydrate the saved targets. Existing Unit bindings use
  stable device IDs and do not need to be recreated.
- **Yeelight Station is open:** leave it running. The plugin prefers the
  compatible loopback daemon and falls back to direct LAN control if the
  daemon disappears.
- **The light responds in the app but not locally:** cloud/app access does not
  prove that LAN Control is enabled or that TCP port `55443` is reachable.
- **No color control appears:** the selector filters targets by the
  capabilities actually advertised by the device.
- **A development checkout becomes dirty after live-link:** FlexDesigner v1
  persists the discovered Catalog into the linked plugin's `config.json`.
  Stop the plugin backend and restore the public empty template before
  committing or packaging.

Do not expose Yeelight LAN ports to the Internet. The protocol is intended for
a trusted local network. The plugin rejects public, loopback, multicast,
hostname and IPv6 device endpoints; its only loopback connection is the
validated Yeelight Station daemon.
