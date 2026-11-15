import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';

const uiDirectory = path.resolve(
  'com.mor4ee.yeelight.plugin',
  'ui'
);

const editors = [
  ['power.vue', 'power'],
  ['brightness.vue', 'brightness'],
  ['color-temperature.vue', 'colorTemperature'],
  ['hue.vue', 'color'],
  ['saturation.vue', 'saturation']
] as const;

test('all five v1 editors are valid Vue SFCs with Catalog selectors', async () => {
  for (const [file, capability] of editors) {
    const source = await readFile(path.join(uiDirectory, file), 'utf8');
    const parsed = parse(source, { filename: file });
    assert.deepEqual(parsed.errors, [], file);
    assert.ok(source.includes('<v-select'), file);
    assert.ok(
      source.includes("action: 'yeelight.catalog.get'"),
      file
    );
    assert.ok(
      source.includes(`requiredCapability: '${capability}'`),
      file
    );
    assert.ok(source.includes('variant="solo-filled"'), file);
    assert.ok(source.includes('density="compact"'), file);
  }
});

test('only Brightness exposes and persists a custom native range', async () => {
  const brightness = await readFile(
    path.join(uiDirectory, 'brightness.vue'),
    'utf8'
  );
  assert.ok(brightness.includes('<v-range-slider'));
  assert.ok(brightness.includes('modelValue.data.minimum'));
  assert.ok(brightness.includes('modelValue.data.maximum'));
  assert.ok(brightness.includes('modelValue.style.slider.min'));
  assert.ok(brightness.includes('modelValue.style.slider.max'));

  for (const file of [
    'power.vue',
    'color-temperature.vue',
    'hue.vue',
    'saturation.vue'
  ]) {
    const source = await readFile(path.join(uiDirectory, file), 'utf8');
    assert.ok(!source.includes('<v-range-slider'), file);
    assert.ok(!source.includes('data.minimum'), file);
    assert.ok(!source.includes('data.maximum'), file);
  }
});

test('Power leaves appearance editing to the native host', async () => {
  const power = await readFile(
    path.join(uiDirectory, 'power.vue'),
    'utf8'
  );

  assert.ok(power.includes('v-model:menu="targetMenuOpen"'));
  assert.ok(power.includes("'target-menu-open': targetMenuOpen"));
  assert.ok(power.includes('.yeelight-editor.target-menu-open'));
  assert.ok(power.includes('min-height: 300px'));
  assert.ok(!power.includes('<v-color-picker'));
  assert.ok(!power.includes('normalizeAppearance'));
  assert.ok(!power.includes('<v-btn-toggle'));
  assert.ok(!power.includes('selectedIconKey'));
  assert.ok(!power.includes('selectIcon'));
  assert.ok(!power.includes('mdi mdi-desk-lamp-off'));
});

test('Color Temperature synchronizes the native range to the selected target', async () => {
  const editor = await readFile(
    path.join(uiDirectory, 'color-temperature.vue'),
    'utf8'
  );

  assert.ok(editor.includes('target?.properties?.min_ct'));
  assert.ok(editor.includes('target?.properties?.max_ct'));
  assert.ok(editor.includes('this.modelValue.style.slider.min'));
  assert.ok(editor.includes('this.modelValue.style.slider.max'));
});

test('Power device selection keeps native style references intact on Apply', async () => {
  const source = await readFile(path.join(uiDirectory, 'power.vue'), 'utf8');
  const { descriptor } = parse(source);
  const editor = new Function(descriptor.script!.content.replace('export default', 'return'))();
  const host = {
    data: { targetId: '' },
    style: { multiStyle: [{ bgColor: '#424242' }, { bgColor: '#ff9800' }] }
  };
  const editingStyleRef = host.style.multiStyle[0];
  const context = {
    modelValue: structuredClone(host),
    $emit(_event: string, payload: object) {
      Object.assign(host, structuredClone(payload));
    }
  };
  editor.methods.selectTarget.call(context, 'test:main');
  editingStyleRef.bgColor = '#135790';
  assert.equal(host.style.multiStyle[0], editingStyleRef);
  assert.equal(host.style.multiStyle[0].bgColor, '#135790');
  assert.equal(host.style.multiStyle[1].bgColor, '#ff9800');
  assert.equal(host.data.targetId, 'test:main');
});

test('all slider editors keep native track width aligned with unit width', async () => {
  for (const file of [
    'brightness.vue',
    'color-temperature.vue',
    'hue.vue',
    'saturation.vue'
  ]) {
    const source = await readFile(path.join(uiDirectory, file), 'utf8');
    assert.ok(source.includes("'modelValue.width'"), file);
    assert.ok(source.includes("'modelValue.style.width'"), file);
    assert.ok(source.includes('const placedWidth = Number(this.modelValue.width)'), file);
    assert.ok(source.includes('syncNativeWidth()'), file);
    if (file !== 'brightness.vue') {
      assert.ok(!source.includes('this.emitChange()'), file);
    }
    assert.ok(
      source.includes('Math.max(28, Math.round(width) - 100)'),
      file
    );
    assert.ok(source.includes('style.slider.width = sliderWidth'), file);
  }
});

test('Hue uses a compact numeric-only native format', async () => {
  const editor = await readFile(path.join(uiDirectory, 'hue.vue'), 'utf8');
  assert.ok(editor.includes("style.slider.format = '%0.0f'"));
});
