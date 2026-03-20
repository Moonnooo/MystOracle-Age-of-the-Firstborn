// Furnace system: place, fuel slot, input (ore), output (bars), smelt over time

import * as THREE from 'three';

const FURNACE_SMELT_TIME = 10; // seconds per smelt

export function createFurnaceSystem(scene, terrain, createStackItem, getFuelBurnTime, getSlotType, getSlotCount, smeltItem, furnaceModelFromLoader = null) {
    const furnaces = [];
    const furnacesByChunk = new Map();
    const chunkSize = terrain.chunkSize || 16;

    function initFurnaceState(mesh) {
        if (!mesh.userData.furnaceInventory) {
            mesh.userData.furnaceInventory = [null, null, null, null]; // [fuel, input, output_smelted, output_coal]
            mesh.userData.fuelRemaining = 0;
            mesh.userData.smeltProgress = 0;
        } else if (mesh.userData.furnaceInventory.length === 3) {
            mesh.userData.furnaceInventory.push(null);
        }
        // Default: furnace is off until explicitly turned on via UI
        if (typeof mesh.userData.furnaceOn !== 'boolean') {
            mesh.userData.furnaceOn = false;
        }
    }

    function getFurnaceInventory(mesh) {
        if (!mesh || !mesh.userData.isFurnace) return null;
        initFurnaceState(mesh);
        return mesh.userData.furnaceInventory;
    }

    function setFurnaceInventory(mesh, inv) {
        if (!mesh || !mesh.userData.isFurnace || !Array.isArray(inv) || inv.length < 3) return;
        mesh.userData.furnaceInventory = [inv[0], inv[1], inv[2], inv[3] ?? null];
    }

    function placeFurnace(x, y, z) {
        let mesh;
        if (furnaceModelFromLoader && furnaceModelFromLoader.isObject3D) {
            mesh = furnaceModelFromLoader.clone(true);
            mesh.visible = true;
            mesh.traverse((c) => {
                if (c.isMesh) {
                    c.castShadow = true;
                    c.receiveShadow = true;
                    c.userData.isFurnace = true;
                }
            });

            // Normalize transform so we can compute a clean bounding box
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.updateMatrixWorld(true);

            // Scale the model to roughly fit a single block footprint
            const bbox = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const maxXZ = Math.max(size.x, size.z);
            if (maxXZ > 0.01) {
                const targetFootprint = 0.9; // slightly smaller than a full block so it doesn't spill into neighbours
                const s = targetFootprint / maxXZ;
                mesh.scale.setScalar(s);
            }

            // Recompute bounds after scaling and center horizontally on the target block
            mesh.updateMatrixWorld(true);
            const scaledBbox = new THREE.Box3().setFromObject(mesh);
            const center = new THREE.Vector3();
            scaledBbox.getCenter(center);
            const modelBottom = scaledBbox.min.y;

            // Place so the bottom of the model sits on top of the block at (x, y, z)
            // and the model is centered in X/Z on that block.
            mesh.position.set(x + 0.5 - center.x, y - modelBottom, z + 0.5 - center.z);
        } else {
            const geom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
            const mat = new THREE.MeshStandardMaterial({ color: 0x555566 });
            mesh = new THREE.Mesh(geom, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
        }
        mesh.userData.isFurnace = true;
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        scene.add(mesh);
        furnaces.push(mesh);
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = furnacesByChunk.get(chunkKey) || [];
        list.push(mesh);
        furnacesByChunk.set(chunkKey, list);
        mesh.userData.furnaceX = x;
        mesh.userData.furnaceY = y;
        mesh.userData.furnaceZ = z;
        mesh.userData.furnaceOn = false;
        initFurnaceState(mesh);
        saveFurnaceData();
        return mesh;
    }

    function removeFurnace(mesh) {
        scene.remove(mesh);
        const idx = furnaces.indexOf(mesh);
        if (idx !== -1) furnaces.splice(idx, 1);
        const cx = Math.floor(mesh.userData.furnaceX / chunkSize);
        const cz = Math.floor(mesh.userData.furnaceZ / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = furnacesByChunk.get(chunkKey);
        if (list) {
            const i = list.indexOf(mesh);
            if (i !== -1) list.splice(i, 1);
            if (list.length === 0) furnacesByChunk.delete(chunkKey);
        }
        saveFurnaceData();
    }

    function update(delta) {
        for (const mesh of furnaces) {
            initFurnaceState(mesh);
            const inv = mesh.userData.furnaceInventory;
            let fuelRemaining = mesh.userData.fuelRemaining || 0;
            let smeltProgress = mesh.userData.smeltProgress || 0;
            const isOn = !!mesh.userData.furnaceOn;

            // When the furnace is turned off, do not consume fuel or progress smelting
            if (!isOn) {
                mesh.userData.fuelRemaining = fuelRemaining;
                mesh.userData.smeltProgress = smeltProgress;
                continue;
            }

            // Refuel from fuel slot when furnace is on
            if (fuelRemaining <= 0 && inv[0]) {
                const fuelType = getSlotType(inv[0]);
                const burnTime = getFuelBurnTime ? getFuelBurnTime(fuelType) : 0;
                if (burnTime > 0) {
                    const count = getSlotCount(inv[0]);
                    if (count <= 1) inv[0] = null;
                    else inv[0] = createStackItem(fuelType, count - 1);
                    fuelRemaining = burnTime;
                    const isWoodFuel = fuelType === 'wood' || fuelType === 4 || fuelType === 'planks' || fuelType === 'stick';
                    if (isWoodFuel && createStackItem) {
                        const coalSlot = inv[3];
                        if (!coalSlot || getSlotType(coalSlot) === 'coal') {
                            const n = coalSlot ? getSlotCount(coalSlot) + 1 : 1;
                            inv[3] = createStackItem('coal', Math.min(100, n));
                        }
                    }
                }
            }

            const inputSlot = inv[1];
            const outputSlot = inv[2];
            const inputType = inputSlot ? getSlotType(inputSlot) : null;
            const resultType = inputType && smeltItem ? smeltItem(inputType) : null;

            if (fuelRemaining > 0 && resultType && inputSlot) {
                smeltProgress += delta;
                fuelRemaining -= delta;
                if (smeltProgress >= FURNACE_SMELT_TIME) {
                    smeltProgress = 0;
                    const inputCount = getSlotCount(inputSlot);
                    if (inputCount <= 1) inv[1] = null;
                    else inv[1] = createStackItem(inputType, inputCount - 1);
                    const outCount = outputSlot ? getSlotCount(outputSlot) : 0;
                    if (outputSlot && getSlotType(outputSlot) === resultType) {
                        inv[2] = createStackItem(resultType, Math.min(100, outCount + 1));
                    } else if (!outputSlot || !inv[2]) {
                        inv[2] = createStackItem(resultType, 1);
                    }
                }
            } else {
                if (!resultType || !inputSlot) smeltProgress = 0;
                if (fuelRemaining > 0) fuelRemaining -= delta;
            }

            mesh.userData.fuelRemaining = Math.max(0, fuelRemaining);
            mesh.userData.smeltProgress = smeltProgress;
        }
    }

    function getFuelRemaining(mesh) { return mesh && mesh.userData ? mesh.userData.fuelRemaining || 0 : 0; }
    function getSmeltProgress(mesh) { return mesh && mesh.userData ? mesh.userData.smeltProgress || 0 : 0; }

    function saveFurnaceData() {
        const allData = {};
        for (const [chunkKey, list] of furnacesByChunk.entries()) {
            const arr = [];
            for (const mesh of list) {
                initFurnaceState(mesh);
                const inv = mesh.userData.furnaceInventory;
                const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
                arr.push({
                    x: mesh.userData.furnaceX, y: mesh.userData.furnaceY, z: mesh.userData.furnaceZ,
                    inv: [ser(inv[0]), ser(inv[1]), ser(inv[2]), ser(inv[3])],
                    fuelRemaining: mesh.userData.fuelRemaining,
                    smeltProgress: mesh.userData.smeltProgress,
                    on: !!mesh.userData.furnaceOn
                });
            }
            if (arr.length) allData[chunkKey] = arr;
        }
        try { localStorage.setItem('voxelFurnaces', JSON.stringify(allData)); } catch (e) {}
    }

    function loadFurnaceData() {
        try { const s = localStorage.getItem('voxelFurnaces'); if (s) return JSON.parse(s); } catch (e) {}
        return {};
    }

    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const savedData = loadFurnaceData();
        const chunkData = savedData[chunkKey] || [];
        for (const data of chunkData) {
            const existing = furnaces.find(f =>
                f.userData.furnaceX === data.x && f.userData.furnaceY === data.y && f.userData.furnaceZ === data.z
            );
            if (existing) {
                if (!scene.children.includes(existing)) scene.add(existing);
                if (data.inv) {
                    const deser = (s) => (s == null ? null : createStackItem(s.type, s.count));
                    existing.userData.furnaceInventory = [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null, data.inv[2] ? deser(data.inv[2]) : null, data.inv[3] ? deser(data.inv[3]) : null];
                    existing.userData.fuelRemaining = data.fuelRemaining || 0;
                    existing.userData.smeltProgress = data.smeltProgress || 0;
                }
                continue;
            }
            let mesh;
            if (furnaceModelFromLoader && furnaceModelFromLoader.isObject3D) {
                mesh = furnaceModelFromLoader.clone(true);
                mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
            } else {
                const geom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
                const mat = new THREE.MeshStandardMaterial({ color: 0x555566 });
                mesh = new THREE.Mesh(geom, mat);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
            }
            mesh.userData.isFurnace = true;
            mesh.position.set(data.x + 0.5, data.y + 0.5, data.z + 0.5);
            mesh.updateMatrixWorld(true);
            mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            scene.add(mesh);
            mesh.userData.furnaceX = data.x;
            mesh.userData.furnaceY = data.y;
            mesh.userData.furnaceZ = data.z;
            const deser = (s) => (s == null ? null : createStackItem(s.type, s.count));
            mesh.userData.furnaceInventory = data.inv && data.inv.length >= 4
                ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null, data.inv[2] ? deser(data.inv[2]) : null, data.inv[3] ? deser(data.inv[3]) : null]
                : data.inv && data.inv.length === 3
                    ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null, data.inv[2] ? deser(data.inv[2]) : null, null]
                    : [null, null, null, null];
            mesh.userData.fuelRemaining = data.fuelRemaining || 0;
            mesh.userData.smeltProgress = data.smeltProgress || 0;
            furnaces.push(mesh);
            const list = furnacesByChunk.get(chunkKey) || [];
            list.push(mesh);
            furnacesByChunk.set(chunkKey, list);
        }
    }

    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const list = furnacesByChunk.get(chunkKey) || [];
        for (const mesh of list) {
            if (mesh && scene.children.includes(mesh)) scene.remove(mesh);
        }
        saveFurnaceData();
        furnacesByChunk.delete(chunkKey);
    }

    function getStateForSave() {
        const chunkSize = terrain.chunkSize || 16;
        const allData = {};
        for (const mesh of furnaces) {
            initFurnaceState(mesh);
            const inv = mesh.userData.furnaceInventory;
            const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
            const cx = Math.floor(mesh.userData.furnaceX / chunkSize);
            const cz = Math.floor(mesh.userData.furnaceZ / chunkSize);
            const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            if (!allData[chunkKey]) allData[chunkKey] = [];
            allData[chunkKey].push({
                x: mesh.userData.furnaceX,
                y: mesh.userData.furnaceY,
                z: mesh.userData.furnaceZ,
                inv: [ser(inv[0]), ser(inv[1]), ser(inv[2]), ser(inv[3])],
                fuelRemaining: mesh.userData.fuelRemaining,
                smeltProgress: mesh.userData.smeltProgress,
                on: !!mesh.userData.furnaceOn
            });
        }
        return allData;
    }

    function restoreFromSave(allData) {
        for (const mesh of furnaces.slice()) {
            if (scene.children.includes(mesh)) scene.remove(mesh);
        }
        furnaces.length = 0;
        furnacesByChunk.clear();
        if (!allData || typeof allData !== 'object') return;
        const deser = (s) => (s == null ? null : createStackItem(s.type, s.count));
        for (const [chunkKey, chunkData] of Object.entries(allData)) {
            if (!Array.isArray(chunkData)) continue;
            for (const data of chunkData) {
                let mesh;
                if (furnaceModelFromLoader && furnaceModelFromLoader.isObject3D) {
                    mesh = furnaceModelFromLoader.clone(true);
                    mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
                } else {
                    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x555566 }));
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                }
                mesh.userData.isFurnace = true;
                mesh.position.set(data.x + 0.5, data.y + 0.5, data.z + 0.5);
                mesh.updateMatrixWorld(true);
                mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
                scene.add(mesh);
                mesh.userData.furnaceX = data.x;
                mesh.userData.furnaceY = data.y;
                mesh.userData.furnaceZ = data.z;
            mesh.userData.furnaceInventory = data.inv && data.inv.length >= 4
                ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null, data.inv[2] ? deser(data.inv[2]) : null, data.inv[3] ? deser(data.inv[3]) : null]
                : data.inv && data.inv.length === 3
                    ? [data.inv[0] ? deser(data.inv[0]) : null, data.inv[1] ? deser(data.inv[1]) : null, data.inv[2] ? deser(data.inv[2]) : null, null]
                    : [null, null, null, null];
            mesh.userData.fuelRemaining = data.fuelRemaining || 0;
            mesh.userData.smeltProgress = data.smeltProgress || 0;
            mesh.userData.furnaceOn = data.on ?? false;
                mesh.userData.furnaceOn = data.on ?? false;
                furnaces.push(mesh);
                const list = furnacesByChunk.get(chunkKey) || [];
                list.push(mesh);
                furnacesByChunk.set(chunkKey, list);
            }
        }
        saveFurnaceData();
    }

    function setFurnaceOn(mesh, on) {
        if (!mesh || !mesh.userData || !mesh.userData.isFurnace) return;
        mesh.userData.furnaceOn = !!on;
        saveFurnaceData();
    }

    function getFurnaceOn(mesh) {
        return !!(mesh && mesh.userData && mesh.userData.furnaceOn);
    }

    return {
        furnaces,
        placeFurnace,
        removeFurnace,
        getFurnaceInventory,
        setFurnaceInventory,
        getFuelRemaining,
        getSmeltProgress,
        setFurnaceOn,
        getFurnaceOn,
        update,
        onChunkLoad,
        onChunkUnload,
        getStateForSave,
        restoreFromSave,
    };
}
