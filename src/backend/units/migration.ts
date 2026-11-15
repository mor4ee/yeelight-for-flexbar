import {
  BRIGHTNESS_UNIT_ID,
  isYeelightUnitId,
  type YeelightUnitId
} from './contracts';
import {
  createDefaultUnitData,
  parseUnitData,
  UNIT_DATA_SCHEMA_VERSION,
  type YeelightUnitData
} from './data';

export interface YeelightUnitMigrationRequest {
  unitId: string;
  originalUnit: {
    data?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type YeelightUnitMigrationResult =
  | {
      data: Record<string, unknown>;
    }
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTargetId(value: Record<string, unknown>): string {
  const candidate =
    value.targetId ??
    value.target ??
    value.deviceId ??
    '';

  if (typeof candidate !== 'string') {
    return '';
  }

  const normalized = candidate.trim().toLowerCase();
  if (/^0x[0-9a-f]{1,16}$/i.test(normalized)) {
    return `${normalized}:main`;
  }
  if (
    /^0x[0-9a-f]{1,16}:(?:main|background)$/i.test(normalized)
  ) {
    return normalized;
  }
  return '';
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeBrightnessData(
  value: Record<string, unknown>
): YeelightUnitData {
  const minimum = integerInRange(
    value.minimum ??
      value.minimumBrightness ??
      value.minBrightness ??
      value.min,
    0,
    99
  );
  const maximum = integerInRange(
    value.maximum ??
      value.maximumBrightness ??
      value.maxBrightness ??
      value.max,
    1,
    100
  );

  if (
    minimum === undefined ||
    maximum === undefined ||
    minimum >= maximum
  ) {
    return {
      ...createDefaultUnitData(BRIGHTNESS_UNIT_ID),
      targetId: readTargetId(value)
    };
  }

  return {
    schemaVersion: UNIT_DATA_SCHEMA_VERSION,
    targetId: readTargetId(value),
    minimum,
    maximum
  };
}

function normalizeUnitData(
  unitId: YeelightUnitId,
  value: unknown
): YeelightUnitData {
  const record = isRecord(value) ? value : {};
  if (unitId === BRIGHTNESS_UNIT_ID) {
    return normalizeBrightnessData(record);
  }
  return {
    schemaVersion: UNIT_DATA_SCHEMA_VERSION,
    targetId: readTargetId(record)
  };
}

function isCanonicalData(
  value: unknown,
  parsed: YeelightUnitData
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const expectedEntries = Object.entries(parsed);
  return (
    Object.keys(value).length === expectedEntries.length &&
    expectedEntries.every(([key, entry]) => value[key] === entry)
  );
}

export function migrateUnitData(
  unitId: YeelightUnitId,
  value: unknown
): YeelightUnitData | undefined {
  try {
    const parsed = parseUnitData(unitId, value);
    return isCanonicalData(value, parsed) ? undefined : parsed;
  } catch {
    return normalizeUnitData(unitId, value);
  }
}

export function migrateYeelightUnit(
  request: YeelightUnitMigrationRequest
): YeelightUnitMigrationResult {
  if (!isYeelightUnitId(request.unitId)) {
    return undefined;
  }
  const data = migrateUnitData(request.unitId, request.originalUnit.data);
  return data
    ? { data: data as unknown as Record<string, unknown> }
    : undefined;
}
