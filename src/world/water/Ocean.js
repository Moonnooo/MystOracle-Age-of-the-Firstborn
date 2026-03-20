/**
 * Ocean pass: ensure every OCEAN column has source water from the seabed
 * surface up through SEA_LEVEL (terrain gen does this too; this repairs edges
 * after edits and keeps modules aligned).
 */
import { isTerrainAlignedWaterColumn } from './waterColumnGuards.js';

export function applyOceansToChunk(voxels, cx, cz, helpers) {
    const { chunkSize, height, SEA_LEVEL, BIOMES, BLOCK_IDS, getColumnInfo } = helpers;

    for (let x = 0; x < chunkSize; x++) {
        for (let z = 0; z < chunkSize; z++) {
            const wx = cx * chunkSize + x;
            const wz = cz * chunkSize + z;
            const { surfaceY, biomeInfo, continentalHeight } = getColumnInfo(wx, wz);
            if (!biomeInfo || biomeInfo.biome !== BIOMES.OCEAN) continue;
            if (!isTerrainAlignedWaterColumn(surfaceY, continentalHeight)) continue;
            if (surfaceY >= SEA_LEVEL) continue;

            const topSolid = voxels[x][surfaceY][z];
            const replaceableTop =
                topSolid === BLOCK_IDS.GRASS ||
                topSolid === BLOCK_IDS.DIRT ||
                topSolid === BLOCK_IDS.STONE ||
                topSolid === BLOCK_IDS.SAND ||
                topSolid === BLOCK_IDS.SNOW;

            const yStart = Math.max(0, surfaceY);
            // SEA_LEVEL is the target surface plane, so the top water voxel is SEA_LEVEL - 1.
            const yEnd = Math.min(height - 1, SEA_LEVEL - 1);
            for (let y = yStart; y <= yEnd; y++) {
                const cur = voxels[x][y][z];
                const isW = cur >= BLOCK_IDS.WATER_LEVEL_0 && cur <= BLOCK_IDS.WATER_LEVEL_6;
                if (cur === 0 || isW) {
                    voxels[x][y][z] = BLOCK_IDS.WATER_LEVEL_0;
                } else if (y === yStart && replaceableTop) {
                    voxels[x][y][z] = BLOCK_IDS.WATER_LEVEL_0;
                }
            }
        }
    }
}

