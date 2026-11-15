import { YeelightProtocolError } from './errors';
import type { YeelightProperties } from './types';

export function reduceProps(
  current: YeelightProperties,
  patch: Readonly<Record<string, string>>
): YeelightProperties {
  const next: Record<string, string> = {
    ...current
  };

  for (const [name, value] of Object.entries(patch)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(name) || typeof value !== 'string') {
      throw new YeelightProtocolError(
        'INVALID_MESSAGE',
        `Invalid Yeelight property patch entry: ${name}`
      );
    }
    next[name] = value;
  }

  return Object.freeze(next);
}

export function readIntegerProperty(
  properties: YeelightProperties,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  const rawValue = properties[name];
  if (rawValue === undefined || !/^-?\d+$/.test(rawValue)) {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

export function readPowerProperty(
  properties: YeelightProperties,
  name = 'power'
): boolean | undefined {
  const value = properties[name];
  if (value === 'on') {
    return true;
  }
  if (value === 'off') {
    return false;
  }
  return undefined;
}
