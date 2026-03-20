/**
 * Shared gates so water features use columns whose top solid matches layered height
 * (avoids caves / overhangs / trees skewing surface scans).
 */

export const WATER_TERRAIN_ALIGN_MAX_DY = 4;

export function isTerrainAlignedWaterColumn(surfaceY, continentalY) {
    if (surfaceY <= 0) return false;
    return Math.abs(surfaceY - continentalY) <= WATER_TERRAIN_ALIGN_MAX_DY;
}
