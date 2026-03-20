import { BLOCK_IDS, isWater, waterLevel } from '../blocksRegistry.js';
import { SEA_LEVEL, BIOMES, getBiomeInfoAt } from '../terrain/biomes.js';
import { computeBaseHeight } from '../terrain/baseHeight.js';
import { applyOceansToChunk } from './Ocean.js';
import { applyLakesToChunk } from './Lake.js';
import { applyRiversToChunk } from './River.js';
import { applyWaterfallsToChunk } from './Waterfall.js';
import { applySwampsToChunk } from './Swamp.js';

/**
 * Modular water controller.
 *
 * Responsibilities:
 * - Runs AFTER terrain chunk voxel data exists.
 * - Delegates to per-feature modules (ocean, river, lake, waterfall, swamp).
 * - Only mutates WATER and surface blocks; does not touch caves/ores.
 */
export function createWaterSystem(scene, terrain) {
    const { chunkSize, height, getChunkKey, getVoxelData } = terrain;
    const voxelData = getVoxelData();

    const MAX_WATER_LEVEL = 6;
    const WATER0 = BLOCK_IDS.WATER_LEVEL_0;

    // Queue-based simulation:
    // - waterQueue: items are world integer positions where water might spread
    // - pendingEdits: edits targeting unloaded chunks (for chunk-edge continuity)
    // - dirtyChunks: chunks whose meshes should be rebuilt after simulation writes
    const waterQueue = [];
    const waterQueueSet = new Set(); // dedupe by pos key
    const pendingEdits = new Map(); // chunkKey -> Map(posKey -> levelNum)
    const dirtyChunks = new Set(); // chunkKey

    const INITIAL_SIM_OPS = 30000;
    const SIM_OPS_PER_UPDATE = 1200;
    let lastWaterDebugLogMs = 0;

    function makePosKey(wx, wy, wz) {
        return `${wx},${wy},${wz}`;
    }

    function worldToChunkLocal(wx, wz) {
        const x = Math.floor(wx);
        const z = Math.floor(wz);
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = getChunkKey(cx, cz);
        const lx = ((x % chunkSize) + chunkSize) % chunkSize;
        const lz = ((z % chunkSize) + chunkSize) % chunkSize;
        return { cx, cz, chunkKey, lx, lz };
    }

    function enqueue(wx, wy, wz) {
        if (wy < 0 || wy >= height) return;
        const key = makePosKey(wx, wy, wz);
        if (waterQueueSet.has(key)) return;
        waterQueueSet.add(key);
        waterQueue.push({ x: wx, y: wy, z: wz, key });
    }

    // Sets water only into AIR (0) or existing water.
    // levelNum is 0..6, where 0 = strong/source.
    function trySetWaterLevel(wx, wy, wz, levelNum) {
        if (levelNum < 0 || levelNum > MAX_WATER_LEVEL) return false;
        if (wy < 0 || wy >= height) return false;

        const { chunkKey, lx, lz } = worldToChunkLocal(wx, wz);
        const voxels = voxelData.get(chunkKey);

        if (!voxels) {
            let chunkEdits = pendingEdits.get(chunkKey);
            if (!chunkEdits) {
                chunkEdits = new Map();
                pendingEdits.set(chunkKey, chunkEdits);
            }
            const posKey = makePosKey(wx, wy, wz);
            const prev = chunkEdits.get(posKey);
            // Stronger water means smaller level number.
            if (prev == null || levelNum < prev) chunkEdits.set(posKey, levelNum);
            return false;
        }

        const cur = voxels[lx][wy][lz] || 0;

        // Never overwrite solids (terrain blocks + vegetation).
        if (cur !== 0 && !isWater(cur)) return false;

        const curLevel = isWater(cur) ? waterLevel(cur) : null; // 0..6
        if (curLevel != null && curLevel <= levelNum) return false; // already stronger/equal

        voxels[lx][wy][lz] = WATER0 + levelNum;
        dirtyChunks.add(chunkKey);
        enqueue(wx, wy, wz);
        return true;
    }

    function applyPendingEditsToChunk(cx, cz) {
        const chunkKey = getChunkKey(cx, cz);
        const chunkEdits = pendingEdits.get(chunkKey);
        if (!chunkEdits || chunkEdits.size === 0) return;

        pendingEdits.delete(chunkKey);

        for (const [posKey, levelNum] of chunkEdits.entries()) {
            const parts = posKey.split(',');
            const wx = parseInt(parts[0], 10);
            const wy = parseInt(parts[1], 10);
            const wz = parseInt(parts[2], 10);
            if (Number.isNaN(wx) || Number.isNaN(wy) || Number.isNaN(wz)) continue;
            trySetWaterLevel(wx, wy, wz, levelNum);
        }
    }

    function isTerrainSupportBlock(type) {
        if (!type) return false;
        if (isWater(type)) return false;
        // Don't allow water to be supported by vegetation blocks.
        if (type === BLOCK_IDS.LOG || type === BLOCK_IDS.LEAVES || type === BLOCK_IDS.PLANKS) return false;
        return true;
    }

    // Floating-water cleanup:
    // Keep water only if it can reach terrain-support by walking downward through
    // a vertical chain of water blocks (within the same x/z column).
    /** Sea/lake/river floor: block directly under the lowest water in each column becomes sand (dirt/grass/stone). */
    function applySandSeabedToChunk(voxels) {
        for (let x = 0; x < chunkSize; x++) {
            for (let z = 0; z < chunkSize; z++) {
                let minWaterY = -1;
                for (let y = 0; y < height; y++) {
                    const t = voxels[x][y][z] || 0;
                    if (isWater(t)) {
                        if (minWaterY < 0 || y < minWaterY) minWaterY = y;
                    }
                }
                if (minWaterY <= 0) continue;
                const belowY = minWaterY - 1;
                const b = voxels[x][belowY][z] || 0;
                if (b === BLOCK_IDS.DIRT || b === BLOCK_IDS.GRASS || b === BLOCK_IDS.STONE) {
                    voxels[x][belowY][z] = BLOCK_IDS.SAND;
                }
            }
        }
    }

    function cleanupChunkWater(cx, cz) {
        const chunkKey = getChunkKey(cx, cz);
        const voxels = voxelData.get(chunkKey);
        if (!voxels) return;

        let changed = false;
        const debugUnsupported = typeof window !== 'undefined' && window.DEBUG_WATER_UNSUPPORTED_SCAN;
        let removedUnsupported = 0;

        for (let lx = 0; lx < chunkSize; lx++) {
            for (let lz = 0; lz < chunkSize; lz++) {
                for (let y = 0; y < height; y++) {
                    const t = voxels[lx][y][lz] || 0;
                    if (!isWater(t)) continue;

                    let yy = y - 1;
                    let supported = false;
                    while (yy >= 0) {
                        const bt = voxels[lx][yy][lz] || 0;
                        if (!bt) {
                            supported = false;
                            break;
                        }
                        if (isWater(bt)) {
                            yy--;
                            continue;
                        }
                        supported = isTerrainSupportBlock(bt);
                        break;
                    }

                    if (!supported) {
                        voxels[lx][y][lz] = 0;
                        changed = true;
                        if (debugUnsupported) removedUnsupported++;
                    }
                }
            }
        }

        if (changed) dirtyChunks.add(chunkKey);

        if (debugUnsupported && changed) {
            console.log(`[WaterDebug] cleanup removed unsupported water at chunk ${cx},${cz}: ${removedUnsupported}`);
        }
    }

    function stepSimulation(maxOps) {
        let ops = 0;
        const dirs4 = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ];

        while (ops < maxOps && waterQueue.length > 0) {
            const pos = waterQueue.pop();
            waterQueueSet.delete(pos.key);

            const { chunkKey, lx, lz } = worldToChunkLocal(pos.x, pos.z);
            const voxels = voxelData.get(chunkKey);
            if (!voxels) {
                ops++;
                continue;
            }

            const cur = voxels[lx][pos.y][lz] || 0;
            if (!isWater(cur)) {
                ops++;
                continue;
            }

            const curLevel = waterLevel(cur); // 0..6

            // 1) Flow down first
            const belowY = pos.y - 1;
            if (belowY >= 0) {
                const below = voxels[lx][belowY][lz] || 0;
                if (below === 0) {
                    trySetWaterLevel(pos.x, belowY, pos.z, 0);
                    ops++;
                    continue;
                }
            }

            // 2) Spread sideways when blocked from going down
            const nextLevel = curLevel + 1;
            if (nextLevel <= MAX_WATER_LEVEL) {
                for (const [dx, dz] of dirs4) {
                    const nwx = pos.x + dx;
                    const nwz = pos.z + dz;
                    // Above the global sea plane, never flow sideways. River/lake seeds at high Y were
                    // smearing across every adjacent air block at the same height (whole hilltops).
                    if (pos.y > SEA_LEVEL) {
                        continue;
                    }
                    const nBh = computeBaseHeight(nwx, nwz);
                    // Match biomes.js: true ocean columns may share a deep water sheet laterally.
                    const neighborIsOceanBiome = nBh <= SEA_LEVEL - 2;
                    // Near coast: don't park sea-level water in the air cell above lower dry land.
                    if (!neighborIsOceanBiome && nBh < SEA_LEVEL && pos.y > nBh) {
                        continue;
                    }
                    trySetWaterLevel(nwx, pos.y, nwz, nextLevel);
                }
            }

            ops++;
        }
    }

    function rebuildDirtyChunks() {
        if (dirtyChunks.size === 0) return;
        const rebuildY = Math.min(height - 1, Math.max(0, Math.floor(SEA_LEVEL)));
        let rebuilt = 0;
        for (const chunkKey of dirtyChunks) {
            if (rebuilt >= 8) break;
            const parts = String(chunkKey).split(',');
            const cx = parseInt(parts[0], 10);
            const cz = parseInt(parts[1], 10);
            if (Number.isNaN(cx) || Number.isNaN(cz)) continue;

            const wx = cx * chunkSize;
            const wz = cz * chunkSize;

            const voxels = voxelData.get(chunkKey);
            if (!voxels) continue;
            const type = voxels[0]?.[rebuildY]?.[0] || 0;

            // Force rebuild for this chunk by triggering terrain.setVoxel pattern.
            terrain.setVoxel(wx, rebuildY, wz, type);
            rebuilt++;
        }
    }

    // Ground surface height for water placement:
    // - ignores vegetation (logs/leaves/planks) so we don't create water on tree tops
    // - ignores water voxels
    function getSurfaceY(wx, wz) {
        for (let y = height - 1; y >= 0; y--) {
            const t = terrain.getVoxelAt(wx, y, wz);
            if (!t) continue;

            // Skip water; we're computing ground for water placement.
            if (t >= BLOCK_IDS.WATER_LEVEL_0 && t <= BLOCK_IDS.WATER_LEVEL_6) continue;

            // Skip tree-related blocks so water doesn't "sit" on top of trees/leaves.
            if (t === BLOCK_IDS.LOG || t === BLOCK_IDS.LEAVES || t === BLOCK_IDS.PLANKS) continue;

            return y;
        }
        return 0;
    }

    function getColumnInfo(wx, wz) {
        const surfaceY = getSurfaceY(wx, wz);
        // Biome/ocean/river/swamp use layered continental height so HUD matches water placement.
        const continentalHeight = computeBaseHeight(wx, wz);
        const biomeInfo = getBiomeInfoAt(wx, wz, continentalHeight);
        return { surfaceY, biomeInfo, continentalHeight };
    }

    function countWater(voxels) {
        let count = 0;
        for (let x = 0; x < chunkSize; x++) {
            for (let y = 0; y < height; y++) {
                for (let z = 0; z < chunkSize; z++) {
                    if (voxels[x][y][z] === BLOCK_IDS.WATER) count++;
                }
            }
        }
        return count;
    }

    function onChunkGenerated(cx, cz) {
        const key = getChunkKey(cx, cz);
        const voxels = voxelData.get(key);
        if (!voxels) return;

        // Bring in any cross-chunk writes queued while neighbors were unloaded.
        applyPendingEditsToChunk(cx, cz);

        const debugOffset = typeof window !== 'undefined' && typeof window.DEBUG_WATER_LEVEL_OFFSET === 'number'
            ? window.DEBUG_WATER_LEVEL_OFFSET
            : 0;
        const effectiveSeaLevel = SEA_LEVEL + debugOffset;

        // Prepare lightweight helpers we pass to each module
        const helpers = {
            chunkSize,
            height,
            SEA_LEVEL: effectiveSeaLevel,
            BIOMES,
            BLOCK_IDS,
            getColumnInfo,
        };

        // Layered placement (each pass only edits water + optional bed blocks):
        // 1) Ocean — repair deep columns (terrain gen already fills most).
        // 2) Lakes — inland basins below sea plane.
        // 3) Rivers — narrow continental channels (see waterLayers + River.js).
        // 4) Waterfalls — cliff sheets next to river drops.
        // 5) Swamps — sparse pools in swamp biome.
        // Modules use waterColumnGuards so voxel “surface” matches computeBaseHeight (±4).
        applyOceansToChunk(voxels, cx, cz, helpers);
        applyLakesToChunk(voxels, cx, cz, helpers);
        applyRiversToChunk(voxels, cx, cz, helpers);
        applyWaterfallsToChunk(voxels, cx, cz, helpers);
        applySwampsToChunk(voxels, cx, cz, helpers);

        // Seeding modules write directly to voxelData; mark this chunk dirty.
        dirtyChunks.add(key);

        // Enqueue only top source water per (x,z) column.
        // This avoids huge queues from deep stacked columns (especially oceans).
        for (let x = 0; x < chunkSize; x++) {
            for (let z = 0; z < chunkSize; z++) {
                let topSourceY = -1;
                for (let y = height - 1; y >= 0; y--) {
                    if (voxels[x][y][z] === WATER0) {
                        topSourceY = y;
                        break;
                    }
                }
                if (topSourceY >= 0) {
                    const wx = cx * chunkSize + x;
                    const wz = cz * chunkSize + z;
                    enqueue(wx, topSourceY, wz);
                }
            }
        }

        // Run bounded simulation to settle water immediately (avoid floating water).
        stepSimulation(INITIAL_SIM_OPS);

        // Cleanup unsupported water after seeding/simulation.
        cleanupChunkWater(cx, cz);

        applySandSeabedToChunk(voxels);

        if (typeof window !== 'undefined' && window.DEBUG_WATER_SIM) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (now - lastWaterDebugLogMs > 2500) {
                lastWaterDebugLogMs = now;
                const counts = Array(MAX_WATER_LEVEL + 1).fill(0);
                for (let x = 0; x < chunkSize; x++) {
                    for (let y = 0; y < height; y++) {
                        for (let z = 0; z < chunkSize; z++) {
                            const t = voxels[x][y][z] || 0;
                            if (!isWater(t)) continue;
                            const lvl = waterLevel(t);
                            if (lvl == null) continue;
                            counts[lvl] += 1;
                        }
                    }
                }
                console.log(`[WaterDebug] chunk ${cx},${cz} queue=${waterQueue.length} waterByLevel=${counts.join(',')}`);
            }
        }

        // Rebuild any chunk meshes we touched.
        rebuildDirtyChunks();
        dirtyChunks.clear();
    }

    // Legacy migration:
    // Older builds used `11` for WATER, but renderer/UI now treats `11` as GOLD_ORE.
    // This remaps any legacy WATER voxels still present in already-generated chunks.
    function remapLegacyWaterId11ToCurrentWater() {
        const voxelData = getVoxelData();
        if (!voxelData || typeof voxelData.entries !== 'function') return 0;

        const oldWaterId = 11;
        const newWaterId = BLOCK_IDS.WATER;

        // If the IDs are already correct, no work.
        if (oldWaterId === newWaterId) return 0;

        const debugOffset = typeof window !== 'undefined' && typeof window.DEBUG_WATER_LEVEL_OFFSET === 'number'
            ? window.DEBUG_WATER_LEVEL_OFFSET
            : 0;
        const effectiveSeaLevel = SEA_LEVEL + debugOffset;

        let changedChunks = 0;

        for (const [chunkKey, voxels] of voxelData.entries()) {
            if (!voxels) continue;
            let changed = false;

            for (let x = 0; x < chunkSize && !changed; x++) {
                for (let y = 0; y <= height - 1; y++) {
                    if (y > effectiveSeaLevel) break; // water should never be above sea-level
                    for (let z = 0; z < chunkSize; z++) {
                        if (voxels[x][y][z] === oldWaterId) {
                            voxels[x][y][z] = newWaterId;
                            changed = true;
                            break;
                        }
                    }
                    if (changed) break;
                }
            }

            if (changed) {
                changedChunks++;
                const parts = String(chunkKey).split(',');
                const cx = parseInt(parts[0], 10);
                const cz = parseInt(parts[1], 10);
                if (!Number.isNaN(cx) && !Number.isNaN(cz)) {
                    onChunkGenerated(cx, cz);
                }
            }
        }

        return changedChunks;
    }

    function onChunkUnload(_cx, _cz) {
        // Currently nothing to clean up; particles/effects are handled elsewhere.
    }

    // Do it once at startup for already-generated chunks.
    remapLegacyWaterId11ToCurrentWater();

    return {
        onChunkGenerated,
        onChunkUnload,
        update(_delta) {
            if (waterQueue.length === 0) return;
            stepSimulation(SIM_OPS_PER_UPDATE);
            rebuildDirtyChunks();
            dirtyChunks.clear();
        },
    };
}

