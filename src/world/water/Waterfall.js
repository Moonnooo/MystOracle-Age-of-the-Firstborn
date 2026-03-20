/**
 * Waterfalls:
 * - Detected where a river column sits next to a much lower neighbor.
 * - We extend a vertical water sheet down the cliff face.
 */
import { isTerrainAlignedWaterColumn } from './waterColumnGuards.js';

export function applyWaterfallsToChunk(voxels, cx, cz, helpers) {
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

    const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
    ];

    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            const wx = cx * chunkSize + x;
            const wz = cz * chunkSize + z;
            const { surfaceY, biomeInfo, continentalHeight } = getColumnInfo(wx, wz);
            if (!biomeInfo || biomeInfo.biome !== BIOMES.RIVER) continue;
            if (!isTerrainAlignedWaterColumn(surfaceY, continentalHeight)) continue;

            for (const [dx, dz] of dirs) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nx >= chunkSize || nz < 0 || nz >= chunkSize) continue;
                const neighborSurface = getSurfaceYLocal(nx, nz);
                const drop = surfaceY - neighborSurface;
                if (drop < 4) continue; // Threshold for "steep" falls

                const topY = Math.min(height - 1, surfaceY + 1);
                const bottomY = Math.max(0, neighborSurface + 1);

                // Seed only the top of the sheet; simulation will flow down.
                if (topY >= 0 && topY < height) {
                    const cur = voxels[nx][topY][nz];
                    const isWater = cur >= BLOCK_IDS.WATER_LEVEL_0 && cur <= BLOCK_IDS.WATER_LEVEL_6;
                    if (cur === 0 || isWater) {
                        voxels[nx][topY][nz] = BLOCK_IDS.WATER_LEVEL_0 ?? BLOCK_IDS.WATER;
                    }
                }
            }
        }
    }
}

