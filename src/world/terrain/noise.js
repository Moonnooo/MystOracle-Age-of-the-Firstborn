// Simple deterministic noise used for terrain generation.
// Kept minimal on purpose so it can be reused by hills/mountains/rivers modules.
class SimplexNoise {
    constructor(seed = 1337) {
        this.seed = seed;
    }

    noise2D(x, y) {
        const s = Math.sin(x * 12.9898 + y * 78.233 + this.seed) * 43758.5453;
        return (s - Math.floor(s)) * 2 - 1;
    }

    noise3D(x, y, z) {
        const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + this.seed) * 43758.5453;
        return (s - Math.floor(s)) * 2 - 1;
    }
}

/**
 * Create a noise instance for world generation.
 * The same instance can be shared across all terrain helpers.
 */
export function createWorldNoise(seed = 1337) {
    return new SimplexNoise(seed);
}

