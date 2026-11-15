import type { YeelightControlCapability } from '../catalog/device-catalog';

export const POWER_UNIT_ID = '@amon/yeelight/power';
export const BRIGHTNESS_UNIT_ID = '@amon/yeelight/brightness';
export const COLOR_TEMPERATURE_UNIT_ID =
  '@amon/yeelight/color-temperature';
export const COLOR_UNIT_ID = '@amon/yeelight/color';
export const SATURATION_UNIT_ID = '@amon/yeelight/saturation';

export const YEELIGHT_UNIT_IDS = [
  POWER_UNIT_ID,
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  SATURATION_UNIT_ID
] as const;

export type YeelightUnitId = (typeof YEELIGHT_UNIT_IDS)[number];

export interface YeelightUnitContract {
  unitId: YeelightUnitId;
  typeId: string;
  name: string;
  icon: string;
  type: 'cycled' | 'custom';
  capability: YeelightControlCapability;
}

export const YEELIGHT_UNIT_CONTRACTS: Readonly<
  Record<YeelightUnitId, YeelightUnitContract>
> = {
  [POWER_UNIT_ID]: {
    unitId: POWER_UNIT_ID,
    typeId: 'amon.yeelight.power',
    name: 'On/Off',
    icon: 'mdi-lightbulb-outline',
    type: 'cycled',
    capability: 'power'
  },
  [BRIGHTNESS_UNIT_ID]: {
    unitId: BRIGHTNESS_UNIT_ID,
    typeId: 'amon.yeelight.brightness',
    name: 'Brightness',
    icon: 'mdi-brightness-6',
    type: 'custom',
    capability: 'brightness'
  },
  [COLOR_TEMPERATURE_UNIT_ID]: {
    unitId: COLOR_TEMPERATURE_UNIT_ID,
    typeId: 'amon.yeelight.color-temperature',
    name: 'Color Temperature',
    icon: 'mdi-thermometer',
    type: 'custom',
    capability: 'colorTemperature'
  },
  [COLOR_UNIT_ID]: {
    unitId: COLOR_UNIT_ID,
    typeId: 'amon.yeelight.color',
    name: 'Hue',
    icon: 'mdi-palette-outline',
    type: 'custom',
    capability: 'color'
  },
  [SATURATION_UNIT_ID]: {
    unitId: SATURATION_UNIT_ID,
    typeId: 'amon.yeelight.saturation',
    name: 'Saturation',
    icon: 'mdi-water-opacity',
    type: 'custom',
    capability: 'saturation'
  }
};

export function isYeelightUnitId(value: unknown): value is YeelightUnitId {
  return (
    typeof value === 'string' &&
    (YEELIGHT_UNIT_IDS as readonly string[]).includes(value)
  );
}

export function yeelightUnitIdFromTypeId(
  typeId: unknown
): YeelightUnitId | undefined {
  if (typeof typeId !== 'string') {
    return undefined;
  }
  return YEELIGHT_UNIT_IDS.find(
    (unitId) => YEELIGHT_UNIT_CONTRACTS[unitId].typeId === typeId
  );
}
