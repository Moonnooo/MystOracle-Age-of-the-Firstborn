/**
 * Layered terrain height & biome generation (Minecraft / Terasology-style pipeline).
 *
 * Pipeline:
 *  1) Low-frequency fBm → continental hills / valleys
 *  2) High-frequency fBm → small bumps (never a single noise call for final height)
 *  3) Subtle domain warp → breaks long flat plateaus
 *  4) Biome classification from independent 2D noise samples
 *  5) Biome-specific height offset (mountains rise, forest/plains subtle)
 *  6) Cross smoothing: center + N + S + E + W samples of the combined raw field
 *
 * @module layeredTerrainGen
 */

// ---------------------------------------------------------------------------
// Smooth 2D value noise (interpolated lattice). Produces gentler terrain than
// raw sin(hash) at a single point.
// ---------------------------------------------------------------------------

function smoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

class SmoothValueNoise2D {
    constructor(seed = 1337) {
        this.seed = Number(seed) || 0;
    }

    /** Single lattice sample in roughly -1..1 */
    _cell(ix, iz) {
        const s = Math.sin(ix * 12.9898 + iz * 78.233 + this.seed * 0.001234) * 43758.5453;
        return ((s - Math.floor(s)) * 2 - 1);
    }

    /**
     * Smooth value noise at fractional world coordinates.
     * @param {number} x
     * @param {number} z
     * @returns {number} approximately -1..1
     */
    noise2D(x, z) {
        const x0 = Math.floor(x);
        const z0 = Math.floor(z);
        const fx = x - x0;
        const fz = z - z0;
        const u = smoothstep(fx);
        const v = smoothstep(fz);
        const a = this._cell(x0, z0);
        const b = this._cell(x0 + 1, z0);
        const c = this._cell(x0, z0 + 1);
        const d = this._cell(x0 + 1, z0 + 1);
        const ab = a + (b - a) * u;
        const cd = c + (d - c) * u;
        return ab + (cd - ab) * v;
    }
}

// ---------------------------------------------------------------------------
// fBm over smooth value noise
// ---------------------------------------------------------------------------

function fbm2D(noise, x, z, octaves, lacunarity, gain) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += noise.noise2D(x * freq, z * freq) * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    return sum / Math.max(1e-6, norm);
}

// ---------------------------------------------------------------------------
// Biome ids (surface gameplay layer; oceans/rivers still decided in biomes.js)
// ---------------------------------------------------------------------------

export const WORLD_BIOMES = Object.freeze({
    PLAINS: 'plains',
    FOREST: 'forest',
    MOUNTAINS: 'mountains',
});

/** Must stay in sync with surface rules in terrain.js generateVoxelType */
export const LAYERED_SURFACE_THRESHOLDS = Object.freeze({
    snowLineY: 40,
    alpineStoneLine: 33,
});

/**
 * @typedef {object} LayeredTerrainGenConfig
 * @property {number} [seed=1337]
 * @property {number} [seaLevel=18]  Used only by generateChunkVoxels / helpers; height field is absolute Y.
 * @property {number} [minHeight=8]
 * @property {number} [maxHeight=58]  Stay below typical world height - margin for air.
 */

/**
 * Factory: creates a self-contained generator with the public API you asked for.
 *
 * @param {LayeredTerrainGenConfig} config
 */
export function createLayeredTerrainGen(config = {}) {
    const seed = config.seed ?? 1337;
    const seaLevel = config.seaLevel ?? 18;
    const minHeight = config.minHeight ?? 8;
    const maxHeight = config.maxHeight ?? 58;

    // Independent noise streams so terrain and biomes stay decorrelated.
    const noiseTerrain = new SmoothValueNoise2D(seed);
    const noiseBiomeA = new SmoothValueNoise2D(seed + 90211);
    const noiseBiomeB = new SmoothValueNoise2D(seed + 47293);
    const noiseDetail = new SmoothValueNoise2D(seed + 33831);
    const noiseWarp = new SmoothValueNoise2D(seed + 19477);

    /**
     * Biome from a separate noise space (not derived from final height).
     * Uses two channels so regions are 2D patches instead of a single diagonal strip.
     */
    function getBiome(x, z) {
        const wx = x;
        const wz = z;
        const a = (noiseBiomeA.noise2D(wx * 0.0022, wz * 0.0022) + 1) * 0.5;
        const b = (noiseBiomeB.noise2D(wx * 0.0022 + 133.7, wz * 0.0022 - 211.3) + 1) * 0.5;
        // "Mountain affinity" vs forest vs plains
        const mtnMetric = a * 0.62 + (1 - b) * 0.38;
        if (mtnMetric > 0.695) return WORLD_BIOMES.MOUNTAINS;
        if (mtnMetric > 0.36) return WORLD_BIOMES.FOREST;
        return WORLD_BIOMES.PLAINS;
    }

    /**
     * Raw combined height before cross-neighbour smoothing (float, world Y).
     */
    function rawHeightAt(wx, wz) {
        // --- Layer A: domain warp (low amplitude) reduces axis-aligned plateaus ---
        const warpStrength = 2.85;
        const warpX = wx + warpStrength * noiseWarp.noise2D(wz * 0.0065, wx * 0.0065);
        const warpZ = wz + warpStrength * noiseWarp.noise2D(wx * 0.0065 + 19.2, wz * 0.0065 + 7.4);

        // --- Layer B: large-scale shape (low frequency, strong amplitude) ---
        const base = fbm2D(noiseTerrain, warpX * 0.0088, warpZ * 0.0088, 5, 2.05, 0.48) * 15.5;

        // --- Layer C: surface detail (higher frequency, small amplitude) ---
        const detail = fbm2D(noiseDetail, wx * 0.064, wz * 0.064, 4, 2.08, 0.52) * 3.35;

        // --- Layer D: biome height shaping ---
        const biome = getBiome(wx, wz);
        let biomeLift = 0;
        if (biome === WORLD_BIOMES.MOUNTAINS) {
            const rugged = Math.abs(fbm2D(noiseDetail, wx * 0.019, wz * 0.019, 3, 2.0, 0.55));
            biomeLift = 7.2 + 3.8 * noiseTerrain.noise2D(wx * 0.027, wz * 0.027) + 2.2 * rugged;
        } else if (biome === WORLD_BIOMES.FOREST) {
            biomeLift = 1.15 * noiseTerrain.noise2D(wx * 0.071, wz * 0.071);
        }

        // Anchor around sea level so oceans stay reachable when biomes.js applies depth rules.
        return seaLevel + base + detail + biomeLift;
    }

    /**
     * Five-tap smoothing: center (weight 2) + N + S + E + W (weight 1 each).
     */
    function smoothedHeightAt(wx, wz) {
        const c = rawHeightAt(wx, wz);
        const n = rawHeightAt(wx, wz - 1);
        const s = rawHeightAt(wx, wz + 1);
        const e = rawHeightAt(wx + 1, wz);
        const w = rawHeightAt(wx - 1, wz);
        return (2 * c + n + s + e + w) / 6;
    }

    /**
     * Final integer surface height for column (wx, wz).
     */
    function getHeight(x, z) {
        const wx = Math.floor(x);
        const wz = Math.floor(z);
        let h = Math.round(smoothedHeightAt(wx, wz));
        if (h < minHeight) h = minHeight;
        if (h > maxHeight) h = maxHeight;
        return h;
    }

    /**
     * Fill a chunk's voxel array [lx][y][lz] with terrain (no caves/ores).
     * Oceans: seabed sand + water up to seaLevel when surface is below sea.
     *
     * @param {number} chunkX
     * @param {number} chunkZ
     * @param {number} chunkSize
     * @param {number} worldHeight
     * @param {object} BLOCK_IDS - block id map (AIR, GRASS, DIRT, STONE, SAND, WATER_LEVEL_0, SNOW)
     * @returns {number[][][]}
     */
    function generateChunk(chunkX, chunkZ, chunkSize, worldHeight, BLOCK_IDS) {
        const {
            AIR = 0,
            GRASS = 3,
            DIRT = 1,
            STONE = 2,
            SAND = 9,
            WATER_LEVEL_0 = 12,
            SNOW = 19,
        } = BLOCK_IDS;

        const voxels = Array.from({ length: chunkSize }, () =>
            Array.from({ length: worldHeight }, () => Array(chunkSize).fill(AIR)),
        );

        const snowLineY = LAYERED_SURFACE_THRESHOLDS.snowLineY;
        const alpineStoneLine = LAYERED_SURFACE_THRESHOLDS.alpineStoneLine;

        for (let lx = 0; lx < chunkSize; lx++) {
            for (let lz = 0; lz < chunkSize; lz++) {
                const wx = chunkX * chunkSize + lx;
                const wz = chunkZ * chunkSize + lz;
                const surfaceY = getHeight(wx, wz);
                const biome = getBiome(wx, wz);
                const ocean = surfaceY <= seaLevel - 2;

                const dirtDepth = biome === WORLD_BIOMES.MOUNTAINS ? 2 : biome === WORLD_BIOMES.FOREST ? 4 : 3;

                for (let y = 0; y < worldHeight; y++) {
                    if (ocean) {
                        if (y < surfaceY) {
                            voxels[lx][y][lz] = STONE;
                            continue;
                        }
                        if (y === surfaceY) {
                            voxels[lx][y][lz] = SAND;
                            continue;
                        }
                        if (y > surfaceY && y <= seaLevel) {
                            voxels[lx][y][lz] = WATER_LEVEL_0;
                            continue;
                        }
                        voxels[lx][y][lz] = AIR;
                        continue;
                    }

                    if (y > surfaceY) {
                        voxels[lx][y][lz] = AIR;
                        continue;
                    }
                    if (y === surfaceY) {
                        if (biome === WORLD_BIOMES.MOUNTAINS) {
                            if (surfaceY >= snowLineY) voxels[lx][y][lz] = SNOW;
                            else if (surfaceY >= alpineStoneLine) voxels[lx][y][lz] = STONE;
                            else voxels[lx][y][lz] = GRASS;
                        } else {
                            voxels[lx][y][lz] = GRASS;
                        }
                        continue;
                    }
                    if (y > surfaceY - dirtDepth) {
                        voxels[lx][y][lz] = DIRT;
                        continue;
                    }
                    voxels[lx][y][lz] = STONE;
                }
            }
        }

        return voxels;
    }

    return {
        getHeight,
        getBiome,
        rawHeightAt,
        smoothedHeightAt,
        generateChunk,
        seaLevel,
        minHeight,
        maxHeight,
        WORLD_BIOMES,
    };
}

// ---------------------------------------------------------------------------
// Process-wide default (same seed → same world as rest of the game expects)
// ---------------------------------------------------------------------------

let _defaultGen = null;

export function getDefaultLayeredTerrainGen() {
    if (!_defaultGen) {
        _defaultGen = createLayeredTerrainGen({ seed: 1337, seaLevel: 18, minHeight: 8, maxHeight: 58 });
    }
    return _defaultGen;
}

/** Shorthand for biome.js + treeGenerator + others */
export function getHeightWorld(wx, wz) {
    return getDefaultLayeredTerrainGen().getHeight(wx, wz);
}

export function getBiomeWorld(wx, wz) {
    return getDefaultLayeredTerrainGen().getBiome(wx, wz);
}
