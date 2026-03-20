import { createWorldNoise } from './noise.js';
import { getBiomeWorld } from './layeredTerrainGen.js';
import { isRiverCorridorConnected, canHaveRiverAtContinentalHeight, isRiverValleyFloor } from './waterLayers.js';

// High-level biome types for gameplay + water modules.
export const BIOMES = {
    PLAINS: 'plains',
    FOREST: 'forest',
    MOUNTAINS: 'mountains',
    DESERT: 'desert', // legacy id; not placed by layered gen (kept for saves / code paths)
    SWAMP: 'swamp',
    OCEAN: 'ocean',
    RIVER: 'river',
};

const moistureNoise = createWorldNoise(12345);

function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

// Shared sea level used when deciding oceans / water modules.
export const SEA_LEVEL = 18;

/**
 * @param {number} wx
 * @param {number} wz
 * @param {number} baseHeight - layered continental surface height from computeBaseHeight(wx,wz) — not voxel scan (avoids water/leaves skewing rivers).
 */
export function getBiomeInfoAt(wx, wz, baseHeight) {
    const moistNoiseVal = moistureNoise.noise2D(wx * 0.001 + 1000, wz * 0.001 + 1000);
    const moisture = clamp01(0.5 + 0.5 * moistNoiseVal);

    if (baseHeight <= SEA_LEVEL - 2) {
        return {
            biome: BIOMES.OCEAN,
            temperature: 0.45,
            moisture,
            desertBlend: 0,
            layeredBiome: null,
        };
    }

    // River: narrow path only (banks keep underlying biome). Water uses the same mask — no dilate (avoids wide flooding).
    // baseHeight must be layered continental height (computeBaseHeight), not voxel top inc. water.
    if (
        canHaveRiverAtContinentalHeight(baseHeight, SEA_LEVEL) &&
        isRiverCorridorConnected(wx, wz) &&
        isRiverValleyFloor(wx, wz)
    ) {
        return {
            biome: BIOMES.RIVER,
            temperature: 0.5,
            moisture,
            desertBlend: 0,
            layeredBiome: getBiomeWorld(wx, wz),
        };
    }

    if (moisture > 0.72 && baseHeight < SEA_LEVEL + 3) {
        return {
            biome: BIOMES.SWAMP,
            temperature: 0.55,
            moisture,
            desertBlend: 0,
            layeredBiome: getBiomeWorld(wx, wz),
        };
    }

    const layered = getBiomeWorld(wx, wz);
    let biome = BIOMES.PLAINS;
    if (layered === 'forest') biome = BIOMES.FOREST;
    else if (layered === 'mountains') biome = BIOMES.MOUNTAINS;
    else biome = BIOMES.PLAINS;

    const temperature = biome === BIOMES.MOUNTAINS ? 0.35 : biome === BIOMES.FOREST ? 0.48 : 0.52;

    return {
        biome,
        temperature,
        moisture,
        desertBlend: 0,
        layeredBiome: layered,
    };
}

export function getBiomeAt(wx, wz, baseHeight) {
    return getBiomeInfoAt(wx, wz, baseHeight).biome;
}
