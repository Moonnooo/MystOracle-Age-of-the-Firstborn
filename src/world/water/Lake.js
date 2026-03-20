/**
 * Lake generator.
 *
 * Heuristic:
 * - Look for local basins (column lower than its 4-neighbors by a small margin).
 * - Only in non-ocean, non-river, non-swamp biomes.
 * - Fill shallow water up to a local waterline below SEA_LEVEL.
 */
import { isTerrainAlignedWaterColumn } from './waterColumnGuards.js';

export function applyLakesToChunk(voxels, cx, cz, helpers) {
    const { chunkSize, height, SEA_LEVEL, BIOMES, BLOCK_IDS, getColumnInfo } = helpers;

    function getSurfaceYLocal(x, z) {
        for (let y = height - 1; y >= 0; y--) {
            const t = voxels[x][y][z];
            if (!t) continue;

            // Skip water while computing ground level.
            if (t >= BLOCK_IDS.WATER_LEVEL_0 && t <= BLOCK_IDS.WATER_LEVEL_6) continue;

            // Skip vegetation so we don't spawn water on top of trees/leaves.
            if (t === BLOCK_IDS.LOG || t === BLOCK_IDS.LEAVES || t === BLOCK_IDS.PLANKS) continue;

            return y;
        }
        return 0;
    }

    const surfaceMap = Array.from({ length: chunkSize }, () =>
        Array(chunkSize).fill(0)
    );

    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            surfaceMap[x][z] = getSurfaceYLocal(x, z);
        }
    }

    for (let x = 1; x < chunkSize - 1; x++) {
        for (let z = 1; z < chunkSize - 1; z++) {
            const wx = cx * chunkSize + x;
            const wz = cz * chunkSize + z;
            const { surfaceY, biomeInfo, continentalHeight } = getColumnInfo(wx, wz);
            if (!biomeInfo) continue;
            if (biomeInfo.biome === BIOMES.OCEAN || biomeInfo.biome === BIOMES.RIVER || biomeInfo.biome === BIOMES.SWAMP) {
                continue;
            }
            if (!isTerrainAlignedWaterColumn(surfaceY, continentalHeight)) continue;

            const h = surfaceMap[x][z];
            const n = surfaceMap[x + 1][z];
            const s = surfaceMap[x - 1][z];
            const e = surfaceMap[x][z + 1];
            const w = surfaceMap[x][z - 1];

            const minNeighbor = Math.min(n, s, e, w);
            const depth = minNeighbor - h;

            // Basin: neighbors clearly higher (deeper pit) — avoids tiny “pond spam” next to rivers.
            if (depth >= 3 && h <= SEA_LEVEL - 1 && h >= SEA_LEVEL - 6) {
                const waterTop = Math.min(SEA_LEVEL - 1, h + depth - 1);
                if (waterTop > h && waterTop < height) {
                    const cur = voxels[x][waterTop][z];
                    const isWater = cur >= BLOCK_IDS.WATER_LEVEL_0 && cur <= BLOCK_IDS.WATER_LEVEL_6;
                    if (cur === 0 || isWater) {
                        voxels[x][waterTop][z] = BLOCK_IDS.WATER_LEVEL_0 ?? BLOCK_IDS.WATER;
                    }
                }
            }
        }
    }
}

