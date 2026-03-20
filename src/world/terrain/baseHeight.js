import { createWorldNoise } from './noise.js';
import { getHeightWorld } from './layeredTerrainGen.js';

/**
 * Shared 3D / misc noise (caves, ores, decorations). Not used for surface height.
 */
export const worldHeightNoise = createWorldNoise();

/**
 * Final smoothed surface height at integer world column (wx, wz).
 * Uses layered terrain: low-frequency base + detail + biome offsets + N/S/E/W smoothing.
 *
 * @param {number} wx
 * @param {number} wz
 * @returns {number} integer Y
 */
export function computeBaseHeight(wx, wz) {
    return getHeightWorld(wx, wz);
}
