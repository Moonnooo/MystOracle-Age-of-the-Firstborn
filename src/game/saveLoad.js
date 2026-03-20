/**
 * Save / Load game state with multiple slots. Uses IndexedDB.
 * State: player (pos, yaw, pitch, health, stamina), hotbar, backpack, sky (time, dayCount), terrain (chunk voxel data).
 */

const DB_NAME = 'VoxelShooterSaves';
const DB_VERSION = 1;
const STORE_NAME = 'saves';
export const NUM_SLOTS = 5;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'slot' });
            }
        };
    });
}

/**
 * @param {number} slotIndex 0..NUM_SLOTS-1
 * @param {object} state { player, hotbar, backpack, sky, terrain, chests, campfires, furnaces, looms, pebbles, mobs, trees }
 */
export function saveGame(slotIndex, state) {
    const slot = Math.max(0, Math.min(NUM_SLOTS - 1, Math.floor(slotIndex)));
    const record = {
        slot,
        version: 1,
        savedAt: new Date().toISOString(),
        dayCount: state.sky?.dayCount ?? 0,
        player: state.player,
        hotbar: state.hotbar,
        backpack: state.backpack,
        sky: state.sky,
        terrain: state.terrain,
        chests: state.chests,
        campfires: state.campfires,
        furnaces: state.furnaces,
        looms: state.looms,
        pebbles: state.pebbles,
        mobs: state.mobs,
        trees: state.trees,
    };
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(record);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
            tx.oncomplete = () => db.close();
        });
    });
}

/**
 * @param {number} slotIndex
 * @returns {Promise<object|null>} state or null if no save
 */
export function loadGame(slotIndex) {
    const slot = Math.max(0, Math.min(NUM_SLOTS - 1, Math.floor(slotIndex)));
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(slot);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const record = req.result;
                if (!record) {
                    db.close();
                    resolve(null);
                    return;
                }
                db.close();
                resolve({
                    player: record.player,
                    hotbar: record.hotbar,
                    backpack: record.backpack,
                    sky: record.sky,
                    terrain: record.terrain,
                    chests: record.chests,
                    campfires: record.campfires,
                    furnaces: record.furnaces,
                    looms: record.looms,
                    pebbles: record.pebbles,
                    mobs: record.mobs,
                    trees: record.trees,
                });
            };
        });
    });
}

/**
 * Delete the save in the given slot.
 * @param {number} slotIndex 0..NUM_SLOTS-1
 * @returns {Promise<void>}
 */
export function deleteSave(slotIndex) {
    const slot = Math.max(0, Math.min(NUM_SLOTS - 1, Math.floor(slotIndex)));
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(slot);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
            tx.oncomplete = () => db.close();
        });
    });
}

/**
 * List all saves for the menu (slot, savedAt, dayCount).
 * @returns {Promise<Array<{ slot: number, savedAt: string, dayCount: number }>>}
 */
export function listSaves() {
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const rows = req.result || [];
                db.close();
                const bySlot = {};
                rows.forEach((r) => { bySlot[r.slot] = r; });
                const list = [];
                for (let i = 0; i < NUM_SLOTS; i++) {
                    list.push({
                        slot: i,
                        savedAt: bySlot[i]?.savedAt ?? null,
                        dayCount: bySlot[i]?.dayCount ?? null,
                    });
                }
                resolve(list);
            };
        });
    });
}
