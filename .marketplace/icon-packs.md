# FlexGate submission copy

Submit two **Iconpack** entries from the author's profile, not as plugins.
Suggested content version for each: **1.0.0** (independent of the host version
in the exported file).

In the observed Iconpack form, use **Artistic**; it has no OS selector.
The gallery PNG and the listing thumbnail are separate. Keep the gallery
preview attached, and include a root-level `thumbnail` PNG data URL in the
`.iconpack`. The FlexDesigner exporter renders up to 18 icons on a transparent
3000 × 152 strip. The public Software LOGO pack's embedded PNG matches its
FlexGate card thumbnail byte for byte. The optional
`scripts/render-iconpack-thumbnails.cjs` tool regenerates our strips.
The [official upload guide](https://flexdocumentation.readthedocs.io/en/latest/troubleshoting/flexgate.html)
describes the form, but does not specify this embedded field.

## Yeelight Vector Icon Pack

15 lighting fixtures in 30 monochrome icons for Flexbar. Choose a white outline
for On and a crossed-out version for Off. Includes bulbs, ceiling and desk
lights, a chandelier, wall and floor lights, panels, and two LED strip shapes.
Transparent backgrounds work best against darker button colors. Assign each
state independently in Foreground. No Yeelight device or plugin is required
to use the artwork.

File: `Icon_Pack/full/Yeelight Vector Icon Pack.iconpack`.
Preview: `vector-preview.png`.

## Yeelight Color Icon Pack

14 lighting fixtures in 84 transparent color icons. Each fixture has an unlit
version plus pale yellow, red, blue, green and Multicolor glow variants. Use a dark
background to bring out the glow. Assign Off and your preferred On color
independently in Foreground; glow colors are part of the artwork and do not
track the light automatically.

File: `Icon_Pack/color/Yeelight Color Icon Pack.iconpack`.
Preview: `color-preview.png`.
