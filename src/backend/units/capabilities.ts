import type { YeelightLogicalTarget } from '../catalog/device-catalog';
import {
  isYeelightUnitId,
  YEELIGHT_UNIT_CONTRACTS,
  type YeelightUnitId
} from './contracts';

export function isTargetCompatible(
  unitId: YeelightUnitId,
  target: Pick<YeelightLogicalTarget, 'capabilities'>
): boolean {
  return target.capabilities.includes(
    YEELIGHT_UNIT_CONTRACTS[unitId].capability
  );
}

export function filterCompatibleTargets(
  unitId: YeelightUnitId,
  targets: readonly YeelightLogicalTarget[]
): YeelightLogicalTarget[] {
  return targets.filter((target) => isTargetCompatible(unitId, target));
}

export function requiredCapabilityForUnit(
  unitId: unknown
): string | undefined {
  return isYeelightUnitId(unitId)
    ? YEELIGHT_UNIT_CONTRACTS[unitId].capability
    : undefined;
}
