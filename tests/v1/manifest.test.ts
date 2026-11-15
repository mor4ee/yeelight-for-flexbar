import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const pluginDirectory = path.resolve('com.mor4ee.yeelight.plugin');

test('FlexDesigner v1 manifest declares the five Stage 13 controls', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginDirectory, 'manifest.json'), 'utf8')
  ) as {
    uuid: string;
    entry: string;
    configPage: string;
    keyLibrary: {
      style: { icon: string };
      children: Array<{
        cid: string;
        config: { keyType: string };
        style: Record<string, unknown>;
        data: Record<string, unknown>;
      }>;
    };
    local: Record<string, {
      Power?: { Title?: string };
      Brightness?: { Title?: string };
      ColorTemperature?: { Title?: string };
      Hue?: { Title?: string };
      Saturation?: { Title?: string };
      Config?: Record<string, unknown>;
    }>;
  };

  assert.equal(manifest.uuid, 'com.mor4ee.yeelight');
  assert.equal(manifest.entry, 'backend/plugin.cjs');
  assert.equal(manifest.configPage, 'global_config');
  assert.ok(manifest.local.en.Config);
  assert.ok(manifest.local.ru.Config);
  assert.deepEqual(
    [
      manifest.local.en.Power?.Title,
      manifest.local.en.Brightness?.Title,
      manifest.local.en.ColorTemperature?.Title,
      manifest.local.en.Hue?.Title,
      manifest.local.en.Saturation?.Title
    ],
    ['On/Off', 'Brightness', 'Color Temperature', 'Hue', 'Saturation']
  );
  assert.deepEqual(
    [
      manifest.local.ru.Power?.Title,
      manifest.local.ru.Brightness?.Title,
      manifest.local.ru.ColorTemperature?.Title,
      manifest.local.ru.Hue?.Title,
      manifest.local.ru.Saturation?.Title
    ],
    ['Вкл/выкл', 'Яркость', 'Цветовая температура', 'Оттенок', 'Насыщенность']
  );

  const children = manifest.keyLibrary.children;
  const logo = await readFile(path.join(pluginDirectory, 'assets', 'brand', 'yeelight.png'));
  assert.equal(manifest.keyLibrary.style.icon, `data:image/png;base64,${logo.toString('base64')}`);
  assert.deepEqual(
    children.map(({ cid }) => cid),
    [
      'com.mor4ee.yeelight.power',
      'com.mor4ee.yeelight.brightness',
      'com.mor4ee.yeelight.color-temperature',
      'com.mor4ee.yeelight.hue',
      'com.mor4ee.yeelight.saturation'
    ]
  );
  assert.deepEqual(
    children.map(({ config }) => config.keyType),
    ['multiState', 'slider', 'slider', 'slider', 'slider']
  );

  for (const child of children) {
    assert.equal(child.data.schemaVersion, 1);
    assert.equal(child.data.targetId, '');
    assert.equal(typeof child.style.icon, 'string');
    assert.equal(typeof child.style.width, 'number');
  }
  assert.deepEqual(children[1].data, {
    schemaVersion: 1,
    targetId: '',
    minimum: 0,
    maximum: 100
  });
  assert.deepEqual(
    children.map(({ style }) => style.icon),
    [
      'mdi mdi-lightbulb-outline',
      'mdi mdi-brightness-6',
      'mdi mdi-thermometer',
      'mdi mdi-palette-outline',
      'mdi mdi-water-opacity'
    ]
  );
  assert.equal(children[0].style.bgColor, '#424242');
  assert.equal(children[0].style.fgColor, '#ffffff');
  assert.deepEqual(children[0].style.multiStyle, [
    {},
    { bgColor: '#ff9800' }
  ]);
  for (const [index, file] of [
    [2, 'color-temperature.png'],
    [3, 'hue.png'],
    [4, 'saturation.png']
  ] as const) {
    const backgroundBytes = await readFile(
      path.join(pluginDirectory, 'assets', 'slider-backgrounds', file)
    );
    assert.equal(children[index].style.showImage, true);
    assert.equal(children[index].style.foregroundOutline, true);
    assert.equal(
      children[index].style.image,
      `data:image/png;base64,${backgroundBytes.toString('base64')}`,
      `${children[index].cid} should use its generated semantic background`
    );
    assert.equal(backgroundBytes.readUInt32BE(16), 360);
    assert.equal(backgroundBytes.readUInt32BE(20), 60);
  }
  for (const child of children.filter(
    ({ cid }) => cid !== 'com.mor4ee.yeelight.brightness'
  )) {
    assert.deepEqual(Object.keys(child.data).sort(), [
      'schemaVersion',
      'targetId'
    ]);
  }
});

test('FlexDesigner v1 UI filenames match cid suffixes used by the official scaffold', async () => {
  await Promise.all([
    'global_config.vue',
    'power.vue',
    'brightness.vue',
    'color-temperature.vue',
    'hue.vue',
    'saturation.vue'
  ].map((file) => readFile(path.join(pluginDirectory, 'ui', file), 'utf8')));
});

test('FlexDesigner v1 default config uses the canonical LAN catalog schema', async () => {
  const config = JSON.parse(
    await readFile(path.join(pluginDirectory, 'config.json'), 'utf8')
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(config).sort(), [
    'catalog',
    'manualAddresses',
    'schemaVersion'
  ]);
  assert.equal(config.schemaVersion, 1);
  assert.equal(Array.isArray(config.manualAddresses), true);
  assert.equal((config.manualAddresses as unknown[]).length, 0);
  assert.equal(Array.isArray(config.catalog), true);
  assert.equal(
    (config.catalog as unknown[]).length,
    0,
    'The committed default config must not contain discovered devices'
  );
});
