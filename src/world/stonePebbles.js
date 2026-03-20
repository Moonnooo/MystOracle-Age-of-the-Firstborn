// Stone pebbles: small world objects on the surface, breakable by hand for stones

import * as THREE from 'three';

const PEBBLES_PER_CHUNK = 8;
const STONES_PER_PEBBLE_MIN = 1;
const STONES_PER_PEBBLE_MAX = 3;

export function createStonePebblesSystem(scene, terrain, modelFromLoader = null) {
    const pebbles = [];
    const pebblesByChunk = new Map();
    const chunkSize = terrain.chunkSize || 16;
    // Tracks which chunks have already had their initial random pebbles spawned.
    // Prevents new random pebbles from appearing in previously visited chunks.
    const initializedChunks = new Set();

    function getChunkKey(cx, cz) {
        return terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
    }

    function placePebble(worldX, worldY, worldZ) {
        // Top of the surface block in world Y (worldY is the voxel Y of the top block)
        const surfaceTopY = worldY + 1;

        let mesh;
        if (modelFromLoader && modelFromLoader.isObject3D) {
            mesh = modelFromLoader.clone(true);
            mesh.traverse((c) => {
                if (c.isMesh) {
                    c.castShadow = true;
                    c.receiveShadow = true;
                }
            });
            // Normalize transform before measuring
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.updateMatrixWorld(true);

            const bbox = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            bbox.getSize(size);

            const targetHeight = 0.2;      // shorter than a quarter block
            const targetFootprint = 0.8;   // comfortably within a single block in X/Z

            let s = 1;
            if (size.y > 0.001) {
                s = Math.min(s, targetHeight / size.y);
            }
            const maxXZ = Math.max(size.x, size.z);
            if (maxXZ > 0.001) {
                s = Math.min(s, targetFootprint / maxXZ);
            }

            mesh.scale.setScalar(s);
            mesh.updateMatrixWorld(true);

            // Recompute bounds after scaling so we can center it on the block
            const bboxAfter = new THREE.Box3().setFromObject(mesh);
            const center = new THREE.Vector3();
            bboxAfter.getCenter(center);
            const modelBottom = bboxAfter.min.y;

            // Center horizontally on the block and sit exactly on top of it
            mesh.position.set(
                worldX + 0.5 - center.x,
                surfaceTopY - modelBottom,
                worldZ + 0.5 - center.z
            );
            mesh.updateMatrixWorld(true);
        } else {
            const radius = 0.15;
            const geom = new THREE.SphereGeometry(radius, 8, 6);
            const mat = new THREE.MeshStandardMaterial({ color: 0x808080 });
            mesh = new THREE.Mesh(geom, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            // Sphere center so bottom of sphere sits on surfaceTopY
            mesh.position.set(worldX + 0.5, surfaceTopY + radius, worldZ + 0.5);
        }
        mesh.userData.isStonePebble = true;
        mesh.userData.pebbleX = worldX;
        mesh.userData.pebbleY = worldY;
        mesh.userData.pebbleZ = worldZ;
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        scene.add(mesh);
        pebbles.push(mesh);
        const cx = Math.floor(worldX / chunkSize);
        const cz = Math.floor(worldZ / chunkSize);
        const key = getChunkKey(cx, cz);
        const arr = pebblesByChunk.get(key) || [];
        arr.push(mesh);
        pebblesByChunk.set(key, arr);
        return mesh;
    }

    function breakPebble(mesh) {
        if (!mesh || !mesh.userData.isStonePebble) return 0;
        scene.remove(mesh);
        const idx = pebbles.indexOf(mesh);
        if (idx !== -1) pebbles.splice(idx, 1);
        const cx = Math.floor(mesh.userData.pebbleX / chunkSize);
        const cz = Math.floor(mesh.userData.pebbleZ / chunkSize);
        const key = getChunkKey(cx, cz);
        const arr = pebblesByChunk.get(key);
        if (arr) {
            const i = arr.indexOf(mesh);
            if (i !== -1) arr.splice(i, 1);
            if (arr.length === 0) pebblesByChunk.delete(key);
        }
        return STONES_PER_PEBBLE_MIN + Math.floor(Math.random() * (STONES_PER_PEBBLE_MAX - STONES_PER_PEBBLE_MIN + 1));
    }

    /** Break any pebble sitting on the block at (worldX, worldY, worldZ); returns stone count or 0. */
    function breakPebbleAt(worldX, worldY, worldZ) {
        const vx = Math.floor(worldX);
        const vy = Math.floor(worldY);
        const vz = Math.floor(worldZ);
        const mesh = pebbles.find(p => p.userData.pebbleX === vx && p.userData.pebbleY === vy && p.userData.pebbleZ === vz);
        if (!mesh) return 0;
        return breakPebble(mesh);
    }

    function getPebbleMeshes() {
        return pebbles.slice();
    }

    function onChunkLoad(cx, cz) {
        const key = getChunkKey(cx, cz);

        // Only spawn random pebbles once per chunk. After that, pebbles in this
        // chunk only come from the existing state (and broken ones stay gone).
        if (!initializedChunks.has(key)) {
            initializedChunks.add(key);
            const wx0 = cx * chunkSize;
            const wz0 = cz * chunkSize;
            for (let i = 0; i < PEBBLES_PER_CHUNK; i++) {
                const lx = Math.floor(Math.random() * chunkSize);
                const lz = Math.floor(Math.random() * chunkSize);
                const wx = wx0 + lx;
                const wz = wz0 + lz;
                let surfaceY = -1;
                if (terrain.getSurfaceYAt) {
                    surfaceY = terrain.getSurfaceYAt(wx, wz);
                } else {
                    for (let y = (terrain.height || 32) - 1; y >= 0; y--) {
                        if (terrain.getVoxelAt(wx, y, wz) !== 0) {
                            surfaceY = y;
                            break;
                        }
                    }
                }
                if (surfaceY >= 0) placePebble(wx, surfaceY, wz);
            }
        }

        // Re-attach existing pebble meshes for this chunk (they may have been
        // unloaded earlier). Broken pebbles have been removed from the arrays,
        // so they will not reappear.
        const arr = pebblesByChunk.get(key) || [];
        for (const mesh of arr) {
            if (mesh && !scene.children.includes(mesh)) {
                scene.add(mesh);
                mesh.updateMatrixWorld(true);
                mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            }
        }
    }

    function onChunkUnload(cx, cz) {
        const key = getChunkKey(cx, cz);
        const arr = pebblesByChunk.get(key) || [];
        for (const mesh of arr) {
            if (mesh && scene.children.includes(mesh)) {
                scene.remove(mesh);
            }
        }
        // Keep pebblesByChunk entry so pebbles for this chunk can be reattached
        // on the next onChunkLoad call; broken pebbles are removed in breakPebble.
    }

    function hasPebblesInChunk(cx, cz) {
        const key = getChunkKey(cx, cz);
        const arr = pebblesByChunk.get(key);
        return !!(arr && arr.length);
    }

    function getStateForSave() {
        const allData = {};

        function ensureChunk(key) {
            if (!allData[key]) {
                allData[key] = { initialized: false, pebbles: [] };
            }
            return allData[key];
        }

        // Mark all chunks that have had their random pebbles spawned at least once
        for (const key of initializedChunks) {
            const bucket = ensureChunk(key);
            bucket.initialized = true;
        }

        // Record positions of all remaining pebbles
        for (const mesh of pebbles) {
            const x = mesh.userData.pebbleX;
            const y = mesh.userData.pebbleY;
            const z = mesh.userData.pebbleZ;
            if (x == null || y == null || z == null) continue;
            const cx = Math.floor(x / chunkSize);
            const cz = Math.floor(z / chunkSize);
            const key = getChunkKey(cx, cz);
            const bucket = ensureChunk(key);
            bucket.pebbles.push({ x, y, z });
        }

        return allData;
    }

    function restoreFromSave(allData) {
        // Clear existing pebbles and state
        for (const mesh of pebbles.slice()) {
            if (mesh && scene.children.includes(mesh)) scene.remove(mesh);
        }
        pebbles.length = 0;
        pebblesByChunk.clear();
        initializedChunks.clear();

        if (!allData || typeof allData !== 'object') return;

        for (const [key, data] of Object.entries(allData)) {
            if (!data || typeof data !== 'object') continue;
            const bucket = data;
            const initialized = !!bucket.initialized;
            const list = Array.isArray(bucket.pebbles) ? bucket.pebbles : [];
            if (initialized) initializedChunks.add(key);
            for (const p of list) {
                if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') continue;
                placePebble(p.x, p.y, p.z);
            }
        }
    }

    return {
        pebbles,
        placePebble,
        breakPebble,
        breakPebbleAt,
        getPebbleMeshes,
        onChunkLoad,
        onChunkUnload,
        hasPebblesInChunk,
        getStateForSave,
        restoreFromSave,
    };
}
