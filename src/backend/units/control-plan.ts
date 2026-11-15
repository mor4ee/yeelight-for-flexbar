import type {
  YeelightLogicalTarget,
  YeelightTargetDomain
} from '../catalog/device-catalog';
import {
  setBrightness,
  setColorTemperatureScene,
  setColorTemperature,
  setHsv,
  setHsvScene,
  setPower,
  setRgbScene,
  togglePower,
  type YeelightCommand
} from '../protocol';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  POWER_UNIT_ID,
  SATURATION_UNIT_ID,
  type YeelightUnitId
} from './contracts';
import {
  parseUnitData,
  type BrightnessUnitData,
  type YeelightUnitData
} from './data';

export const COLOR_TEMPERATURE_MINIMUM = 1_700;
export const COLOR_TEMPERATURE_MAXIMUM = 6_500;

export interface ColorTemperatureRange {
  minimum: number;
  maximum: number;
}

export interface ConfirmedTargetContext {
  target: YeelightLogicalTarget;
  properties: Readonly<Record<string, string>>;
  supportedMethods: ReadonlySet<string>;
}

export interface UnitControlPreview {
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>;
  targetId: string;
  position: number;
  value: number;
  displayText: string;
  off?: boolean;
}

export interface UnitControlPlan {
  preview?: UnitControlPreview;
  commands: YeelightCommand[];
}

export class UnitControlError extends Error {
  constructor(
    readonly code:
      | 'INVALID_POSITION'
      | 'MISSING_CONFIRMED_STATE'
      | 'OFFLINE'
      | 'UNSUPPORTED_CAPABILITY',
    message: string
  ) {
    super(message);
    this.name = 'UnitControlError';
  }
}

function methodName(
  domain: YeelightTargetDomain,
  method: string
): string {
  return domain === 'background' ? `bg_${method}` : method;
}

function assertSupported(
  context: ConfirmedTargetContext,
  method: string
): void {
  if (!context.supportedMethods.has(methodName(context.target.domain, method))) {
    throw new UnitControlError(
      'UNSUPPORTED_CAPABILITY',
      `Target does not advertise ${methodName(context.target.domain, method)}`
    );
  }
}

function confirmedInteger(
  properties: Readonly<Record<string, string>>,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(properties[name]);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new UnitControlError(
      'MISSING_CONFIRMED_STATE',
      `Confirmed Yeelight property is unavailable: ${name}`
    );
  }
  return value;
}

function confirmedPower(
  properties: Readonly<Record<string, string>>
): boolean {
  if (properties.power === 'on') {
    return true;
  }
  if (properties.power === 'off') {
    return false;
  }
  throw new UnitControlError(
    'MISSING_CONFIRMED_STATE',
    'Confirmed Yeelight power state is unavailable'
  );
}

function clampPosition(position: number): number {
  if (!Number.isFinite(position) || position < 0 || position > 1) {
    throw new UnitControlError(
      'INVALID_POSITION',
      'Slider position must be normalized from 0 to 1'
    );
  }
  return Math.min(1, Math.max(0, position));
}

export function colorTemperatureRange(
  context: ConfirmedTargetContext
): ColorTemperatureRange {
  const minimum = Number(context.properties.min_ct);
  const maximum = Number(context.properties.max_ct);
  if (
    Number.isInteger(minimum) &&
    Number.isInteger(maximum) &&
    minimum >= COLOR_TEMPERATURE_MINIMUM &&
    maximum <= COLOR_TEMPERATURE_MAXIMUM &&
    minimum < maximum
  ) {
    return { minimum, maximum };
  }
  return {
    minimum: COLOR_TEMPERATURE_MINIMUM,
    maximum: COLOR_TEMPERATURE_MAXIMUM
  };
}

function backgroundPowerOnScene(
  context: ConfirmedTargetContext
): YeelightCommand {
  assertSupported(context, 'set_scene');
  const brightness = confirmedInteger(
    context.properties,
    'bright',
    1,
    100
  );
  const colorMode = confirmedInteger(
    context.properties,
    'color_mode',
    1,
    3
  );

  if (colorMode === 1) {
    return setRgbScene(
      confirmedInteger(context.properties, 'rgb', 0, 0xff_ff_ff),
      brightness,
      'background'
    );
  }
  if (colorMode === 2) {
    return setColorTemperatureScene(
      confirmedInteger(context.properties, 'ct', 1_700, 6_500),
      brightness,
      'background'
    );
  }
  return setHsvScene(
    confirmedInteger(context.properties, 'hue', 0, 359),
    confirmedInteger(context.properties, 'sat', 0, 100),
    brightness,
    'background'
  );
}

function powerCommands(
  enabled: boolean,
  context: ConfirmedTargetContext
): YeelightCommand[] {
  if (
    enabled &&
    context.target.domain === 'background' &&
    context.target.model === 'lamp15' &&
    context.supportedMethods.has('bg_set_scene')
  ) {
    return [backgroundPowerOnScene(context)];
  }

  const setPowerMethod = methodName(context.target.domain, 'set_power');
  if (context.supportedMethods.has(setPowerMethod)) {
    return [setPower(enabled, context.target.domain)];
  }

  const toggleMethod = methodName(context.target.domain, 'toggle');
  if (context.supportedMethods.has(toggleMethod)) {
    return [togglePower(context.target.domain)];
  }

  throw new UnitControlError(
    'UNSUPPORTED_CAPABILITY',
    `Target does not advertise ${setPowerMethod} or ${toggleMethod}`
  );
}

export function createPowerControlPlan(
  data: unknown,
  context: ConfirmedTargetContext
): UnitControlPlan {
  parseUnitData(POWER_UNIT_ID, data);
  const enabled = confirmedPower(context.properties);
  return {
    commands: powerCommands(!enabled, context)
  };
}

export function createSliderControlPlan(
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>,
  data: unknown,
  position: number,
  context: ConfirmedTargetContext
): UnitControlPlan {
  const normalizedPosition = clampPosition(position);
  const parsedData = parseUnitData(unitId, data);
  const domain = context.target.domain;

  if (unitId === BRIGHTNESS_UNIT_ID) {
    assertSupported(context, 'set_bright');
    const brightnessData = parsedData as BrightnessUnitData;
    const brightness = Math.round(
      brightnessData.minimum +
        normalizedPosition *
          (brightnessData.maximum - brightnessData.minimum)
    );
    const off = brightnessData.minimum === 0 && brightness === 0;
    const preview: UnitControlPreview = {
      unitId,
      targetId: brightnessData.targetId,
      position: normalizedPosition,
      value: brightness,
      displayText: off ? 'OFF' : `${brightness}%`,
      off
    };

    if (off) {
      return {
        preview,
        commands: confirmedPower(context.properties)
          ? powerCommands(false, context)
          : []
      };
    }

    const commands: YeelightCommand[] = [];
    if (!confirmedPower(context.properties)) {
      commands.push(...powerCommands(true, context));
    }
    commands.push(setBrightness(brightness, domain));
    return {
      preview,
      commands
    };
  }

  if (unitId === COLOR_TEMPERATURE_UNIT_ID) {
    assertSupported(context, 'set_ct_abx');
    const range = colorTemperatureRange(context);
    const kelvin = Math.round(
      range.minimum +
        normalizedPosition *
          (range.maximum - range.minimum)
    );
    return {
      preview: {
        unitId,
        targetId: parsedData.targetId,
        position: normalizedPosition,
        value: kelvin,
        displayText: `${kelvin} K`
      },
      commands: [setColorTemperature(kelvin, domain)]
    };
  }

  if (unitId === COLOR_UNIT_ID) {
    assertSupported(context, 'set_hsv');
    const hue = Math.min(359, Math.round(normalizedPosition * 359));
    const saturation = confirmedInteger(
      context.properties,
      'sat',
      0,
      100
    );
    return {
      preview: {
        unitId,
        targetId: parsedData.targetId,
        position: normalizedPosition,
        value: hue,
        displayText: `${hue}°`
      },
      commands: [setHsv(hue, saturation, domain)]
    };
  }

  if (unitId === SATURATION_UNIT_ID) {
    assertSupported(context, 'set_hsv');
    const saturation = Math.round(normalizedPosition * 100);
    const hue = confirmedInteger(context.properties, 'hue', 0, 359);
    return {
      preview: {
        unitId,
        targetId: parsedData.targetId,
        position: normalizedPosition,
        value: saturation,
        displayText: `${saturation}%`
      },
      commands: [setHsv(hue, saturation, domain)]
    };
  }

  return assertNever(unitId);
}

export function createUnitPreview(
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>,
  data: unknown,
  position: number,
  context: ConfirmedTargetContext
): UnitControlPreview {
  return createSliderControlPlan(unitId, data, position, context).preview!;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported Yeelight Unit: ${String(value)}`);
}

export function targetIdFromUnitData(
  unitId: YeelightUnitId,
  data: unknown
): string {
  return (parseUnitData(unitId, data) as YeelightUnitData).targetId;
}
