import { BLOCK_IDS, isWater } from './blocksRegistry.js';
import { computeBaseHeight } from './terrain/baseHeight.js';
import { getBiomeInfoAt, BIOMES } from './terrain/biomes.js';

// Simple tree prefab definition: trunk + leaves, relative to trunk base (bottom log) world Y.
export const TREE_PREFABS = {
    simple: [
        // Trunk (4 blocks tall)
        { dx: 0, dy: 0, dz: 0, type: BLOCK_IDS.LOG },
        { dx: 0, dy: 1, dz: 0, type: BLOCK_IDS.LOG },
        { dx: 0, dy: 2, dz: 0, type: BLOCK_IDS.LOG },
        { dx: 0, dy: 3, dz: 0, type: BLOCK_IDS.LOG },

        // Leaves layer around the top
        { dx:  0, dy: 4, dz:  0, type: BLOCK_IDS.LEAVES },
        { dx:  1, dy: 4, dz:  0, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 4, dz:  0, type: BLOCK_IDS.LEAVES },
        { dx:  0, dy: 4, dz:  1, type: BLOCK_IDS.LEAVES },
        { dx:  0, dy: 4, dz: -1, type: BLOCK_IDS.LEAVES },

        // Optional diagonal leaves slightly lower
        { dx:  1, dy: 3, dz:  1, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 3, dz:  1, type: BLOCK_IDS.LEAVES },
        { dx:  1, dy: 3, dz: -1, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 3, dz: -1, type: BLOCK_IDS.LEAVES },
    ],
};

/**
 * Staged growth: each index is voxels to ADD at that step (cumulative build).
 * Index 0 = sapling only (no voxels). Matches TREE_PREFABS.simple when fully grown.
 */
export const TREE_GROWTH_DELTAS = [
    [],
    [{ dx: 0, dy: 0, dz: 0, type: BLOCK_IDS.LOG }],
    [{ dx: 0, dy: 1, dz: 0, type: BLOCK_IDS.LOG }],
    [{ dx: 0, dy: 2, dz: 0, type: BLOCK_IDS.LOG }],
    [{ dx: 0, dy: 3, dz: 0, type: BLOCK_IDS.LOG }],
    [
        { dx: 0, dy: 4, dz: 0, type: BLOCK_IDS.LEAVES },
        { dx: 1, dy: 4, dz: 0, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 4, dz: 0, type: BLOCK_IDS.LEAVES },
        { dx: 0, dy: 4, dz: 1, type: BLOCK_IDS.LEAVES },
        { dx: 0, dy: 4, dz: -1, type: BLOCK_IDS.LEAVES },
    ],
    [
        { dx: 1, dy: 3, dz: 1, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 3, dz: 1, type: BLOCK_IDS.LEAVES },
        { dx: 1, dy: 3, dz: -1, type: BLOCK_IDS.LEAVES },
        { dx: -1, dy: 3, dz: -1, type: BLOCK_IDS.LEAVES },
    ],
];

export function getMaxTreeGrowthStage() {
    return TREE_GROWTH_DELTAS.length - 1;
}

/** Apply one growth step (stage index 1..max). Stage 0 is never passed here. */
export function applyTreeGrowthDelta(terrain, trunkBaseX, trunkBaseY, trunkBaseZ, stageIndex) {
    const delta = TREE_GROWTH_DELTAS[stageIndex];
    if (!delta || !delta.length) return;
    for (const { dx, dy, dz, type } of delta) {
        const wx = trunkBaseX + dx;
        const wy = trunkBaseY + dy;
        const wz = trunkBaseZ + dz;
        if (terrain.getVoxelAt(wx, wy, wz) === BLOCK_IDS.AIR) {
            terrain.setVoxel(wx, wy, wz, type);
        }
    }
}

/**
 * Stamp a prefab into the world at (baseX, baseY, baseZ) using terrain.setVoxel.
 */
export function placeTreePrefab(terrain, baseX, baseY, baseZ, prefabName = 'simple') {
    const pattern = TREE_PREFABS[prefabName];
    if (!pattern) return;

    for (const { dx, dy, dz, type } of pattern) {
        const wx = baseX + dx;
        const wy = baseY + dy;
        const wz = baseZ + dz;
        terrain.setVoxel(wx, wy, wz, type);
    }
}

/**
 * Highest solid block that can support a tree: not fluid, with air (not water) above for the trunk base.
 * Ignores the topmost water column so oaks are not placed on oceans/rivers/lakes.
 */
function findDryLandSurfaceY(terrain, wx, wz) {
    const maxY = terrain.height != null ? terrain.height : 32;
    for (let y = maxY - 1; y >= 1; y--) {
        const ground = terrain.getVoxelAt(wx, y, wz);
        if (ground === BLOCK_IDS.AIR || isWater(ground)) continue;
        const above = terrain.getVoxelAt(wx, y + 1, wz);
        if (above !== BLOCK_IDS.AIR) continue;
        return y;
    }
    return -1;
}

/**
 * Place up to maxTrees voxel trees in the given chunk (cx, cz).
 * Uses dry land with clear air above — never the top voxel of a water column.
 */
export function generateTreesForChunk(terrain, cx, cz, maxTrees = 2) {
    const chunkSize = terrain.chunkSize || 16;
    for (let i = 0; i < maxTrees; i++) {
        if (Math.random() > 0.4) continue; // ~40% chance per slot

        const lx = Math.floor(Math.random() * chunkSize);
        const lz = Math.floor(Math.random() * chunkSize);
        const wx = cx * chunkSize + lx;
        const wz = cz * chunkSize + lz;

        const surfaceY = findDryLandSurfaceY(terrain, wx, wz);
        if (surfaceY < 0) continue;

        // Skip trees in true desert: we want the desert to feel mostly barren.
        // We compute the biome based on the same baseHeight function used by
        // terrain so the rings line up.
        const baseHeight = computeBaseHeight(wx, wz);
        const biomeInfo = getBiomeInfoAt(wx, wz, baseHeight);
        if (biomeInfo.biome === BIOMES.MOUNTAINS) {
            continue;
        }
        if (biomeInfo.biome === BIOMES.DESERT && biomeInfo.desertBlend > 0.2) {
            continue;
        }

        // Also avoid placing trees directly on sand.
        const surfaceBlock = terrain.getVoxelAt(wx, surfaceY, wz);
        if (surfaceBlock === BLOCK_IDS.SAND) continue;

        const trunkBaseY = surfaceY + 1;
        if (terrain.treeSystem && typeof terrain.treeSystem.registerWildGrowingTree === 'function') {
            terrain.treeSystem.registerWildGrowingTree(wx, trunkBaseY, wz);
        } else {
            placeTreePrefab(terrain, wx, trunkBaseY, wz, 'simple');
        }
    }
}

