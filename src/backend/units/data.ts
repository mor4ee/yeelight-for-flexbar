import {
  BRIGHTNESS_UNIT_ID,
  type YeelightUnitId
} from './contracts';

export const UNIT_DATA_SCHEMA_VERSION = 1 as const;

export interface BaseUnitData {
  schemaVersion: typeof UNIT_DATA_SCHEMA_VERSION;
  targetId: string;
}

export interface BrightnessUnitData extends BaseUnitData {
  minimum: number;
  maximum: number;
}

export type YeelightUnitData = BaseUnitData | BrightnessUnitData;

const TARGET_ID_PATTERN =
  /^0x[0-9a-f]{1,16}:(?:main|background)$/i;

export class UnitDataValidationError extends TypeError {
  constructor(
    readonly unitId: YeelightUnitId,
    readonly issues: readonly string[]
  ) {
    super(`Invalid data for ${unitId}: ${issues.join('; ')}`);
    this.name = 'UnitDataValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validateBaseData(
  value: Record<string, unknown>,
  issues: string[]
): void {
  if (value.schemaVersion !== UNIT_DATA_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${UNIT_DATA_SCHEMA_VERSION}`);
  }
  if (
    typeof value.targetId !== 'string' ||
    (value.targetId !== '' && !TARGET_ID_PATTERN.test(value.targetId))
  ) {
    issues.push('targetId must be empty or a stable Yeelight target id');
  }
}

export function parseUnitData(
  unitId: YeelightUnitId,
  value: unknown
): YeelightUnitData {
  if (!isRecord(value)) {
    throw new UnitDataValidationError(unitId, ['data must be an object']);
  }

  const issues: string[] = [];
  validateBaseData(value, issues);

  if (unitId === BRIGHTNESS_UNIT_ID) {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'targetId',
        'minimum',
        'maximum'
      ])
    ) {
      issues.push('data contains missing or unsupported fields');
    }
    if (
      !Number.isInteger(value.minimum) ||
      (value.minimum as number) < 0 ||
      (value.minimum as number) > 99
    ) {
      issues.push('minimum must be an integer from 0 to 99');
    }
    if (
      !Number.isInteger(value.maximum) ||
      (value.maximum as number) < 1 ||
      (value.maximum as number) > 100
    ) {
      issues.push('maximum must be an integer from 1 to 100');
    }
    if (
      Number.isInteger(value.minimum) &&
      Number.isInteger(value.maximum) &&
      (value.minimum as number) >= (value.maximum as number)
    ) {
      issues.push('minimum must be less than maximum');
    }
  } else if (!hasExactKeys(value, ['schemaVersion', 'targetId'])) {
    issues.push('data contains missing or unsupported fields');
  }

  if (issues.length > 0) {
    throw new UnitDataValidationError(unitId, issues);
  }

  if (unitId === BRIGHTNESS_UNIT_ID) {
    return {
      schemaVersion: UNIT_DATA_SCHEMA_VERSION,
      targetId: (value.targetId as string).toLowerCase(),
      minimum: value.minimum as number,
      maximum: value.maximum as number
    };
  }

  return {
    schemaVersion: UNIT_DATA_SCHEMA_VERSION,
    targetId: (value.targetId as string).toLowerCase()
  };
}

export function createDefaultUnitData(
  unitId: YeelightUnitId
): YeelightUnitData {
  if (unitId === BRIGHTNESS_UNIT_ID) {
    return {
      schemaVersion: UNIT_DATA_SCHEMA_VERSION,
      targetId: '',
      minimum: 0,
      maximum: 100
    };
  }

  return {
    schemaVersion: UNIT_DATA_SCHEMA_VERSION,
    targetId: ''
  };
}
