/**
 * World state: one place for all "world that grows and ages" save/restore.
 *
 * Currently handles:
 * - Trees (3D tree meshes, stumps, staged voxel growth: sapling → trunk → leaves)
 *
 * Planned / easy to add:
 * - Grass (short, long, sharp grass; growth stages)
 * - Per-chunk lastVisitedTime so when a chunk is reloaded after time away,
 *   plants can "age" while unloaded
 */

/**
 * Build the world-state object to save (trees, and later grass, growth metadata).
 * @param {object} treeSystem - Tree system with getStateForSave()
 * @param {object} [grassSystem] - Optional grass system with getStateForSave() (future)
 * @returns {{ trees: object, grass?: object }}
 */
export function getWorldStateForSave(treeSystem, grassSystem = null) {
    const out = {
        trees: treeSystem && typeof treeSystem.getStateForSave === 'function'
            ? treeSystem.getStateForSave()
            : {},
    };
    if (grassSystem && typeof grassSystem.getStateForSave === 'function') {
        out.grass = grassSystem.getStateForSave();
    }
    return out;
}

/**
 * Restore world state from a saved state (trees, and later grass).
 * Call after terrain chunks are restored so chunk keys match.
 * @param {object} state - Loaded state: { trees?, grass? }
 * @param {object} treeSystem - Tree system with restoreFromSave()
 * @param {object} [grassSystem] - Optional grass system with restoreFromSave() (future)
 */
export function restoreWorldState(state, treeSystem, grassSystem = null) {
    if (!state || typeof state !== 'object') return;
    if (state.trees != null && treeSystem && typeof treeSystem.restoreFromSave === 'function') {
        treeSystem.restoreFromSave(state.trees);
    }
    if (state.grass != null && grassSystem && typeof grassSystem.restoreFromSave === 'function') {
        grassSystem.restoreFromSave(state.grass);
    }
}
