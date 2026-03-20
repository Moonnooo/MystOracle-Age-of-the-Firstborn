// Central registry for numeric block IDs and their metadata.
// Keeps terrain generation, rendering, and inventory in sync.

export const BLOCK_IDS = {
    AIR: 0,
    DIRT: 1,
    STONE: 2,
    GRASS: 3,

    LOG: 4,
    LEAVES: 5,
    PLANKS: 6,
    COAL_ORE: 7,
    IRON_ORE: 8,

    // Biome-related blocks
    SAND: 9,
    CACTUS: 10,

    // Resources
    GOLD_ORE: 11,

    // Fluids (dynamic water levels; level number increases as water weakens)
    // WATER_LEVEL_0 is a full source.
    WATER_LEVEL_0: 12,
    WATER_LEVEL_1: 13,
    WATER_LEVEL_2: 14,
    WATER_LEVEL_3: 15,
    WATER_LEVEL_4: 16,
    WATER_LEVEL_5: 17,
    WATER_LEVEL_6: 18,

    // Backwards-compat alias: older code that used a single WATER id maps to level 0.
    WATER: 12,

    /** Alpine / snow cap (atlas tile; can be retextured as true snow). */
    SNOW: 19,
};

// Basic metadata; textures can be wired to your textures system if needed.
export const BLOCK_DEFS = {
    [BLOCK_IDS.DIRT]:   { name: 'Dirt',   color: [0.55, 0.27, 0.07], texture: 'dirt' },
    [BLOCK_IDS.STONE]:  { name: 'Stone',  color: [0.5, 0.5, 0.5],    texture: 'stone' },
    [BLOCK_IDS.GRASS]:  { name: 'Grass',  color: [0.2, 0.8, 0.2],    texture: 'grass_side+top+dirt' },

    [BLOCK_IDS.LOG]:    { name: 'Log',    color: [0.55, 0.35, 0.2],  texture: 'oak_log+oak_log_top' },
    [BLOCK_IDS.LEAVES]: { name: 'Leaves', color: [0.2, 0.55, 0.2],   texture: 'oak_leaves' },
    [BLOCK_IDS.PLANKS]: { name: 'Planks', color: [0.7, 0.55, 0.35],  texture: 'oak_planks' },
    [BLOCK_IDS.COAL_ORE]: { name: 'Coal Ore', color: [0.2, 0.2, 0.2], texture: 'coal_ore' },
    [BLOCK_IDS.IRON_ORE]: { name: 'Iron Ore', color: [0.5, 0.4, 0.35], texture: 'iron_ore' },

    [BLOCK_IDS.GOLD_ORE]: { name: 'Gold Ore', color: [0.9, 0.8, 0.2], texture: 'gold_ore' },

    [BLOCK_IDS.SAND]:   { name: 'Sand',   color: [0.95, 0.9, 0.4],   texture: 'sand' },
    [BLOCK_IDS.CACTUS]: { name: 'Cactus', color: [0.25, 0.8, 0.25],  texture: 'cactus_side+top+bottom' },

    // Water levels share the same visuals for now; the simulation logic controls behavior.
    [BLOCK_IDS.WATER_LEVEL_0]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_1]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_2]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_3]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_4]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_5]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },
    [BLOCK_IDS.WATER_LEVEL_6]: { name: 'Water',   color: [0.2, 0.4, 0.9], texture: 'water_still' },

    [BLOCK_IDS.SNOW]: { name: 'Snow', color: [0.92, 0.95, 1.0], texture: 'snow' },
};

export function getBlockDef(id) {
    return BLOCK_DEFS[id] || null;
}

export function getBlockName(id) {
    return BLOCK_DEFS[id]?.name || 'unknown';
}

export function isWater(id) {
    return id >= BLOCK_IDS.WATER_LEVEL_0 && id <= BLOCK_IDS.WATER_LEVEL_6;
}

// Returns 0..6 for water ids; null for non-water.
export function waterLevel(id) {
    if (!isWater(id)) return null;
    return id - BLOCK_IDS.WATER_LEVEL_0;
}

// Very simple solidity rule for now; adjust as you add non-solid blocks.
export function isSolid(id) {
    if (id === BLOCK_IDS.AIR) return false;
    if (isWater(id)) return false;
    return true;
}

