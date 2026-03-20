/**
 * River placement — uses the same water-layer mask as biomes.js (waterLayers.js).
 * Fills a short vertical column of source water and optional sand riverbed so streams read visually.
 */
import { computeBaseHeight } from '../terrain/baseHeight.js';
import {
    isRiverCorridorConnected,
    canHaveRiverAtContinentalHeight,
    getRiverColumnDepth,
    isRiverValleyFloor,
} from '../terrain/waterLayers.js';
import { isTerrainAlignedWaterColumn } from './waterColumnGuards.js';

export function applyRiversToChunk(voxels, cx, cz, helpers) {
    const { chunkSize, height, SEA_LEVEL, BLOCK_IDS } = helpers;

    function getSurfaceYLocal(x, z) {
        for (let y = height - 1; y >= 0; y--) {
            const t = voxels[x][y][z];
            if (!t) continue;
            if (t >= BLOCK_IDS.WATER_LEVEL_0 && t <= BLOCK_IDS.WATER_LEVEL_6) continue;
            if (t === BLOCK_IDS.LOG || t === BLOCK_IDS.LEAVES || t === BLOCK_IDS.PLANKS) continue;
            return y;
        }
        return 0;
    }

    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            const wx = cx * chunkSize + x;
            const wz = cz * chunkSize + z;

            const continentalY = computeBaseHeight(wx, wz);
            if (!canHaveRiverAtContinentalHeight(continentalY, SEA_LEVEL)) continue;
            if (!isRiverCorridorConnected(wx, wz)) continue;
            if (!isRiverValleyFloor(wx, wz)) continue;

            const surfaceY = getSurfaceYLocal(x, z);
            if (surfaceY <= 0) continue;
            if (!isTerrainAlignedWaterColumn(surfaceY, continentalY)) continue;

            const depth = getRiverColumnDepth(surfaceY, SEA_LEVEL);
            const topSolid = voxels[x][surfaceY][z];
            const replaceableTop =
                topSolid === BLOCK_IDS.GRASS ||
                topSolid === BLOCK_IDS.DIRT ||
                topSolid === BLOCK_IDS.STONE ||
                topSolid === BLOCK_IDS.SAND ||
                topSolid === BLOCK_IDS.SNOW;
            if (!replaceableTop) continue;

            // Optional sand bed one below surface (soft subsurface only).
            if (surfaceY > 0) {
                const sub = voxels[x][surfaceY - 1][z];
                if (sub === BLOCK_IDS.GRASS || sub === BLOCK_IDS.DIRT) {
                    voxels[x][surfaceY - 1][z] = BLOCK_IDS.SAND;
                }
            }

            // Carve downward so the water surface stays flush with terrain instead of stacking above it.
            const topY = surfaceY;
            const bottomY = Math.max(1, topY - depth + 1);

            for (let y = bottomY; y <= topY; y++) {
                const cur = voxels[x][y][z];
                const isW = cur >= BLOCK_IDS.WATER_LEVEL_0 && cur <= BLOCK_IDS.WATER_LEVEL_6;
                if (cur === 0 || isW) {
                    voxels[x][y][z] = BLOCK_IDS.WATER_LEVEL_0;
                } else if (y === topY) {
                    voxels[x][y][z] = BLOCK_IDS.WATER_LEVEL_0;
                } else if (
                    cur === BLOCK_IDS.DIRT ||
                    cur === BLOCK_IDS.GRASS ||
                    cur === BLOCK_IDS.STONE ||
                    cur === BLOCK_IDS.SAND ||
                    cur === BLOCK_IDS.SNOW
                ) {
                    voxels[x][y][z] = BLOCK_IDS.WATER_LEVEL_0;
                }
            }
        }
    }
}
