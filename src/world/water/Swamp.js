/**
 * Swamp water:
 * - Only inside BIOMES.SWAMP.
 * - Low elevation, shallow and flat.
 */
import { isTerrainAlignedWaterColumn } from './waterColumnGuards.js';

export function applySwampsToChunk(voxels, cx, cz, helpers) {
    const { chunkSize, height, SEA_LEVEL, BIOMES, BLOCK_IDS, getColumnInfo } = helpers;

    function getSurfaceYLocal(x, z) {
        for (let y = height - 1; y >= 0; y--) {
            const t = voxels[x][y][z];
            if (!t) continue;

            // Skip water while computing ground.
            if (t >= BLOCK_IDS.WATER_LEVEL_0 && t <= BLOCK_IDS.WATER_LEVEL_6) continue;

            // Skip vegetation.
            if (t === BLOCK_IDS.LOG || t === BLOCK_IDS.LEAVES || t === BLOCK_IDS.PLANKS) continue;

            return y;
        }
        return 0;
    }

    // Precompute a surface map (terrain surface ignoring vegetation/water)
    const surfaceMap = Array.from({ length: chunkSize }, () => Array(chunkSize).fill(0));
    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            surfaceMap[x][z] = getSurfaceYLocal(x, z);
        }
    }

    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            const wx = cx * chunkSize + x;
            const wz = cz * chunkSize + z;
            const { surfaceY, biomeInfo, continentalHeight } = getColumnInfo(wx, wz);
            if (!biomeInfo || biomeInfo.biome !== BIOMES.SWAMP) continue;
            if (!isTerrainAlignedWaterColumn(surfaceY, continentalHeight)) continue;

            // Swamps should be mostly land with only small pools.
            // Seed water only in deeper local basins and only very near sea level.
            if (surfaceY > SEA_LEVEL - 1) continue;

            // Basin detection: local surface must be noticeably lower than neighbors.
            const s = surfaceMap[x][z];
            const n = surfaceMap[x + 1]?.[z] ?? s;
            const w = surfaceMap[x - 1]?.[z] ?? s;
            const e = surfaceMap[x]?.[z + 1] ?? s;
            const ww = surfaceMap[x]?.[z - 1] ?? s;
            const minNeighbor = Math.min(n, w, e, ww);
            const depth = minNeighbor - s;
            if (depth < 2) continue; // only deeper depressions become pools

            // Extra moisture gate to keep pools sparse.
            if ((biomeInfo.moisture ?? 0) < 0.78) continue;

            // Seed a 1-block-deep pool surface.
            const waterTop = Math.min(height - 1, s + 1);
            if (waterTop <= s) continue;

            const cur = voxels[x][waterTop][z];
            const isWater = cur >= BLOCK_IDS.WATER_LEVEL_0 && cur <= BLOCK_IDS.WATER_LEVEL_6;
            if (cur === 0 || isWater) {
                voxels[x][waterTop][z] = BLOCK_IDS.WATER_LEVEL_0 ?? BLOCK_IDS.WATER;
            }
        }
    }
}

