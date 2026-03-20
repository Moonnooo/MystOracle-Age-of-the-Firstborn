// Loom system: place loom, put wool in → get string out (no fuel).

import * as THREE from 'three';

const LOOM_PROCESS_TIME = 4; // seconds per wool → 1 string

export function createLoomSystem(scene, terrain, createStackItem, getSlotType, getSlotCount, loomModelFromLoader = null) {
    const looms = [];
    const loomsByChunk = new Map();
    const chunkSize = terrain.chunkSize || 16;

    function initLoomState(mesh) {
        if (!mesh.userData.loomInventory) {
            mesh.userData.loomInventory = [null, null]; // [input: wool, output: string]
            mesh.userData.loomProgress = 0;
        }
    }

    function getLoomInventory(mesh) {
        if (!mesh || !mesh.userData.isLoom) return null;
        initLoomState(mesh);
        return mesh.userData.loomInventory;
    }

    function setLoomInventory(mesh, inv) {
        if (!mesh || !mesh.userData.isLoom || !Array.isArray(inv) || inv.length < 2) return;
        mesh.userData.loomInventory = [inv[0], inv[1]];
    }

    function placeLoom(x, y, z) {
        let mesh;
        if (loomModelFromLoader && loomModelFromLoader.isObject3D) {
            mesh = loomModelFromLoader.clone(true);
            mesh.visible = true;
            mesh.traverse((c) => {
                if (c.isMesh) {
                    c.castShadow = true;
                    c.receiveShadow = true;
                    c.userData.isLoom = true;
                }
            });
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const maxXZ = Math.max(size.x, size.z);
            if (maxXZ > 0.01) {
                const targetFootprint = 0.9;
                const s = targetFootprint / maxXZ;
                mesh.scale.setScalar(s);
            }
            mesh.updateMatrixWorld(true);
            const scaledBbox = new THREE.Box3().setFromObject(mesh);
            const center = new THREE.Vector3();
            scaledBbox.getCenter(center);
            const modelBottom = scaledBbox.min.y;
            mesh.position.set(x + 0.5 - center.x, y - modelBottom, z + 0.5 - center.z);
        } else {
            const geom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
            const mat = new THREE.MeshStandardMaterial({ color: 0x8b7355 });
            mesh = new THREE.Mesh(geom, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
        }
        mesh.userData.isLoom = true;
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        scene.add(mesh);
        looms.push(mesh);
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = loomsByChunk.get(chunkKey) || [];
        list.push(mesh);
        loomsByChunk.set(chunkKey, list);
        mesh.userData.loomX = x;
        mesh.userData.loomY = y;
        mesh.userData.loomZ = z;
        initLoomState(mesh);
        saveLoomData();
        return mesh;
    }

    function removeLoom(mesh) {
        scene.remove(mesh);
        const idx = looms.indexOf(mesh);
        if (idx !== -1) looms.splice(idx, 1);
        const cx = Math.floor(mesh.userData.loomX / chunkSize);
        const cz = Math.floor(mesh.userData.loomZ / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = loomsByChunk.get(chunkKey);
        if (list) {
            const i = list.indexOf(mesh);
            if (i !== -1) list.splice(i, 1);
            if (list.length === 0) loomsByChunk.delete(chunkKey);
        }
        saveLoomData();
    }

    function update(delta) {
        for (const mesh of looms) {
            initLoomState(mesh);
            const inv = mesh.userData.loomInventory;
            let progress = mesh.userData.loomProgress || 0;
            const inputSlot = inv[0];
            const outputSlot = inv[1];
            const isWool = inputSlot && getSlotType(inputSlot) === 'wool';

            if (isWool && inputSlot) {
                progress += delta;
                if (progress >= LOOM_PROCESS_TIME) {
                    progress = 0;
                    const inputCount = getSlotCount(inputSlot);
                    if (inputCount <= 1) inv[0] = null;
                    else inv[0] = createStackItem('wool', inputCount - 1);
                    const outCount = outputSlot && getSlotType(outputSlot) === 'string' ? getSlotCount(outputSlot) : 0;
                    if (outputSlot && getSlotType(outputSlot) === 'string') {
                        inv[1] = createStackItem('string', Math.min(100, outCount + 1));
                    } else if (!outputSlot || !inv[1]) {
                        inv[1] = createStackItem('string', 1);
                    }
                }
            } else {
                progress = 0;
            }

            mesh.userData.loomProgress = progress;
        }
    }

    function getLoomProgress(mesh) {
        return mesh && mesh.userData ? mesh.userData.loomProgress || 0 : 0;
    }

    function saveLoomData() {
        const allData = {};
        for (const [chunkKey, list] of loomsByChunk.entries()) {
            const arr = [];
            for (const mesh of list) {
                initLoomState(mesh);
                const inv = mesh.userData.loomInventory;
                const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
                arr.push({
                    x: mesh.userData.loomX, y: mesh.userData.loomY, z: mesh.userData.loomZ,
                    inv: [ser(inv[0]), ser(inv[1])],
                    loomProgress: mesh.userData.loomProgress
                });
            }
            if (arr.length) allData[chunkKey] = arr;
        }
        try { localStorage.setItem('voxelLooms', JSON.stringify(allData)); } catch (e) {}
    }

    function loadLoomData() {
        try { const s = localStorage.getItem('voxelLooms'); if (s) return JSON.parse(s); } catch (e) {}
        return {};
    }

    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const savedData = loadLoomData();
        const chunkData = savedData[chunkKey] || [];
        const deser = (s) => (s == null ? null : createStackItem(s.type, s.count));
        for (const data of chunkData) {
            const existing = looms.find(f =>
                f.userData.loomX === data.x && f.userData.loomY === data.y && f.userData.loomZ === data.z
            );
            if (existing) {
                if (!scene.children.includes(existing)) scene.add(existing);
                if (data.inv) {
                    existing.userData.loomInventory = [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null];
                    existing.userData.loomProgress = data.loomProgress || 0;
                }
                continue;
            }
            let mesh;
            if (loomModelFromLoader && loomModelFromLoader.isObject3D) {
                mesh = loomModelFromLoader.clone(true);
                mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.userData.isLoom = true; } });
                mesh.position.set(0, 0, 0);
                mesh.rotation.set(0, 0, 0);
                mesh.scale.set(1, 1, 1);
                mesh.updateMatrixWorld(true);
                const bbox = new THREE.Box3().setFromObject(mesh);
                const size = new THREE.Vector3();
                bbox.getSize(size);
                const maxXZ = Math.max(size.x, size.z);
                if (maxXZ > 0.01) {
                    const s = 0.9 / maxXZ;
                    mesh.scale.setScalar(s);
                }
                mesh.updateMatrixWorld(true);
                const scaledBbox = new THREE.Box3().setFromObject(mesh);
                const center = new THREE.Vector3();
                scaledBbox.getCenter(center);
                const modelBottom = scaledBbox.min.y;
                mesh.position.set(data.x + 0.5 - center.x, data.y - modelBottom, data.z + 0.5 - center.z);
            } else {
                mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x8b7355 }));
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                mesh.position.set(data.x + 0.5, data.y + 0.5, data.z + 0.5);
            }
            mesh.userData.isLoom = true;
            mesh.updateMatrixWorld(true);
            mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            scene.add(mesh);
            mesh.userData.loomX = data.x;
            mesh.userData.loomY = data.y;
            mesh.userData.loomZ = data.z;
            mesh.userData.loomInventory = data.inv && data.inv.length >= 2
                ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null]
                : [null, null];
            mesh.userData.loomProgress = data.loomProgress || 0;
            looms.push(mesh);
            const list = loomsByChunk.get(chunkKey) || [];
            list.push(mesh);
            loomsByChunk.set(chunkKey, list);
        }
    }

    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = loomsByChunk.get(chunkKey) || [];
        for (const mesh of list) {
            if (mesh && scene.children.includes(mesh)) scene.remove(mesh);
        }
        loomsByChunk.delete(chunkKey);
        saveLoomData();
    }

    function getStateForSave() {
        const allData = {};
        for (const mesh of looms) {
            initLoomState(mesh);
            const inv = mesh.userData.loomInventory;
            const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
            const cx = Math.floor(mesh.userData.loomX / chunkSize);
            const cz = Math.floor(mesh.userData.loomZ / chunkSize);
            const key = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            if (!allData[key]) allData[key] = [];
            allData[key].push({
                x: mesh.userData.loomX, y: mesh.userData.loomY, z: mesh.userData.loomZ,
                inv: [ser(inv[0]), ser(inv[1])],
                loomProgress: mesh.userData.loomProgress
            });
        }
        return allData;
    }

    function restoreFromSave(allData) {
        for (const mesh of looms.slice()) {
            if (scene.children.includes(mesh)) scene.remove(mesh);
        }
        looms.length = 0;
        loomsByChunk.clear();
        if (!allData || typeof allData !== 'object') return;
        const deser = (s) => (s == null ? null : createStackItem(s.type, s.count));
        for (const [chunkKey, chunkData] of Object.entries(allData)) {
            if (!Array.isArray(chunkData)) continue;
            for (const data of chunkData) {
                let mesh;
                if (loomModelFromLoader && loomModelFromLoader.isObject3D) {
                    mesh = loomModelFromLoader.clone(true);
                    mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.userData.isLoom = true; } });
                    mesh.position.set(0, 0, 0);
                    mesh.rotation.set(0, 0, 0);
                    mesh.scale.set(1, 1, 1);
                    mesh.updateMatrixWorld(true);
                    const bbox = new THREE.Box3().setFromObject(mesh);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const maxXZ = Math.max(size.x, size.z);
                    if (maxXZ > 0.01) {
                        const s = 0.9 / maxXZ;
                        mesh.scale.setScalar(s);
                    }
                    mesh.updateMatrixWorld(true);
                    const scaledBbox = new THREE.Box3().setFromObject(mesh);
                    const center = new THREE.Vector3();
                    scaledBbox.getCenter(center);
                    const modelBottom = scaledBbox.min.y;
                    mesh.position.set(data.x + 0.5 - center.x, data.y - modelBottom, data.z + 0.5 - center.z);
                } else {
                    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x8b7355 }));
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    mesh.position.set(data.x + 0.5, data.y + 0.5, data.z + 0.5);
                }
                mesh.userData.isLoom = true;
                mesh.updateMatrixWorld(true);
                mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
                scene.add(mesh);
                mesh.userData.loomX = data.x;
                mesh.userData.loomY = data.y;
                mesh.userData.loomZ = data.z;
                mesh.userData.loomInventory = data.inv && data.inv.length >= 2
                    ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null]
                    : [null, null];
                mesh.userData.loomProgress = data.loomProgress || 0;
                looms.push(mesh);
                const list = loomsByChunk.get(chunkKey) || [];
                list.push(mesh);
                loomsByChunk.set(chunkKey, list);
            }
        }
        saveLoomData();
    }

    return {
        looms,
        placeLoom,
        removeLoom,
        getLoomInventory,
        setLoomInventory,
        getLoomProgress,
        update,
        onChunkLoad,
        onChunkUnload,
        getStateForSave,
        restoreFromSave,
    };
}
