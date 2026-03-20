// Campfire system: place, interact, fuel-based cooking with input/output slots

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../assets/assetBase.js';

const CAMPFIRE_COOK_TIME = 5; // seconds per item

export function createCampfireSystem(scene, terrain, player, backpackSlots, createStackItem, cookItem, getFuelBurnTime, getSlotType, getSlotCount, campfireModelFromLoader = null) {
    const campfires = [];
    const campfiresByChunk = new Map();

    let campfireModel = campfireModelFromLoader;
    if (!campfireModel) {
        const loader = new GLTFLoader();
        loader.load(ASSET_BASE + 'models/campfire.glb', (gltf) => {
            campfireModel = gltf.scene;
        });
    }

    function initCampfireState(mesh) {
        if (!mesh.userData.campfireInventory) {
            mesh.userData.campfireInventory = [null, null, null, null]; // [fuel, input, output_cooked, output_coal]
            mesh.userData.fuelRemaining = 0;
            mesh.userData.cookProgress = 0;
        } else if (mesh.userData.campfireInventory.length === 3) {
            mesh.userData.campfireInventory.push(null); // upgrade to 4 slots (coal output)
        }
    }

    function getCampfireInventory(mesh) {
        if (!mesh || !mesh.userData.isCampfire) return null;
        initCampfireState(mesh);
        return mesh.userData.campfireInventory;
    }

    function setCampfireInventory(mesh, inv) {
        if (!mesh || !mesh.userData.isCampfire || !Array.isArray(inv) || inv.length < 3) return;
        mesh.userData.campfireInventory = [inv[0], inv[1], inv[2], inv[3] ?? null];
    }

    function placeCampfire(x, y, z) {
        let mesh;
        if (campfireModel && campfireModel.isObject3D) {
            mesh = campfireModel.clone(true);
        } else {
            const geom = new THREE.BoxGeometry(0.7, 0.7, 0.7);
            const mat = new THREE.MeshStandardMaterial({ color: 0xff9933 });
            mesh = new THREE.Mesh(geom, mat);
        }
        mesh.visible = true;
        mesh.userData.isCampfire = true;
        mesh.traverse((c) => {
            if (c.isMesh) {
                c.castShadow = true;
                c.receiveShadow = true;
                c.userData.isCampfire = true;
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

        scene.add(mesh);
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        campfires.push(mesh);
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkCampfires = campfiresByChunk.get(chunkKey) || [];
        chunkCampfires.push(mesh);
        campfiresByChunk.set(chunkKey, chunkCampfires);
        mesh.userData.campfireX = x;
        mesh.userData.campfireY = y;
        mesh.userData.campfireZ = z;
        initCampfireState(mesh);
        saveCampfireData();
        return mesh;
    }

    function getCampfireAt(pos) {
        for (const mesh of campfires) {
            if (mesh.position.distanceTo(pos) < 1.2) return mesh;
        }
        return null;
    }

    function removeCampfire(mesh) {
        scene.remove(mesh);
        const idx = campfires.indexOf(mesh);
        if (idx !== -1) campfires.splice(idx, 1);
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(mesh.userData.campfireX / chunkSize);
        const cz = Math.floor(mesh.userData.campfireZ / chunkSize);
        const chunkKey = `${cx},${cz}`;
        const chunkCampfires = campfiresByChunk.get(chunkKey);
        if (chunkCampfires) {
            const chunkIdx = chunkCampfires.indexOf(mesh);
            if (chunkIdx !== -1) chunkCampfires.splice(chunkIdx, 1);
            if (chunkCampfires.length === 0) campfiresByChunk.delete(chunkKey);
        }
        saveCampfireData();
    }

    function update(delta) {
        const getType = getSlotType || (s => (s && typeof s === 'object' ? s.type : s));
        const getCount = getSlotCount || (s => (s && typeof s === 'object' ? s.count : 1));
        for (const mesh of campfires) {
            initCampfireState(mesh);
            const inv = mesh.userData.campfireInventory;
            let fuelRemaining = mesh.userData.fuelRemaining || 0;
            let cookProgress = mesh.userData.cookProgress || 0;

            // Refuel from fuel slot
            if (fuelRemaining <= 0 && inv[0]) {
                const fuelType = getType(inv[0]);
                const burnTime = getFuelBurnTime ? getFuelBurnTime(fuelType) : 0;
                if (burnTime > 0) {
                    const count = getCount(inv[0]);
                    if (count <= 1) {
                        inv[0] = null;
                    } else {
                        inv[0] = createStackItem(fuelType, count - 1);
                    }
                    fuelRemaining = burnTime;
                    // Wood-based fuel (logs, planks, sticks) produces 1 coal as it burns; coal as fuel does not
                    const isWoodFuel = fuelType === 'wood' || fuelType === 4 || fuelType === 'planks' || fuelType === 'stick';
                    if (isWoodFuel && createStackItem) {
                        const coalSlot = inv[3];
                        if (!coalSlot || getType(coalSlot) === 'coal') {
                            const n = coalSlot ? getCount(coalSlot) + 1 : 1;
                            inv[3] = createStackItem('coal', Math.min(100, n));
                        }
                    }
                }
            }

            // Burn fuel and cook
            const inputSlot = inv[1];
            const outputSlot = inv[2];
            const inputType = inputSlot ? getType(inputSlot) : null;
            const cookedType = inputType && cookItem ? cookItem(inputType) : null;

            if (fuelRemaining > 0 && cookedType && inputSlot) {
                cookProgress += delta;
                fuelRemaining -= delta;
                if (cookProgress >= CAMPFIRE_COOK_TIME) {
                    cookProgress = 0;
                    const inputCount = getCount(inputSlot);
                    if (inputCount <= 1) inv[1] = null;
                    else inv[1] = createStackItem(inputType, inputCount - 1);
                    const outCount = outputSlot ? getCount(outputSlot) : 0;
                    if (outputSlot && getType(outputSlot) === cookedType) {
                        inv[2] = createStackItem(cookedType, Math.min(100, outCount + 1));
                    } else if (!outputSlot || !inv[2]) {
                        inv[2] = createStackItem(cookedType, 1);
                    }
                }
            } else {
                if (!cookedType || !inputSlot) cookProgress = 0;
                if (fuelRemaining > 0) fuelRemaining -= delta;
            }

            mesh.userData.fuelRemaining = Math.max(0, fuelRemaining);
            mesh.userData.cookProgress = cookProgress;
        }
    }

    function getFuelRemaining(mesh) {
        return mesh && mesh.userData ? mesh.userData.fuelRemaining || 0 : 0;
    }
    function getCookProgress(mesh) {
        return mesh && mesh.userData ? mesh.userData.cookProgress || 0 : 0;
    }

    function saveCampfireData() {
        const allData = {};
        for (const [chunkKey, chunkCampfires] of campfiresByChunk.entries()) {
            const arr = [];
            for (const mesh of chunkCampfires) {
                initCampfireState(mesh);
                const inv = mesh.userData.campfireInventory;
                const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
                arr.push({
                    x: mesh.userData.campfireX,
                    y: mesh.userData.campfireY,
                    z: mesh.userData.campfireZ,
                    inv: [ser(inv[0]), ser(inv[1]), ser(inv[2]), ser(inv[3])],
                    fuelRemaining: mesh.userData.fuelRemaining,
                    cookProgress: mesh.userData.cookProgress
                });
            }
            if (arr.length) allData[chunkKey] = arr;
        }
        try { localStorage.setItem('voxelCampfires', JSON.stringify(allData)); } catch (e) {}
    }

    function loadCampfireData() {
        try {
            const s = localStorage.getItem('voxelCampfires');
            if (s) return JSON.parse(s);
        } catch (e) {}
        return {};
    }

    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const savedData = loadCampfireData();
        const chunkData = savedData[chunkKey] || [];
        for (const data of chunkData) {
            const existing = campfires.find(c =>
                c.userData.campfireX === data.x && c.userData.campfireY === data.y && c.userData.campfireZ === data.z
            );
            if (existing) {
                if (!scene.children.includes(existing)) scene.add(existing);
                if (data.inv) {
                    const deser = (s) => (s == null ? null : (typeof s === 'object' ? createStackItem(s.type, s.count) : s));
                    existing.userData.campfireInventory = [(data.inv[0] && deser(data.inv[0])), (data.inv[1] && deser(data.inv[1])), (data.inv[2] && deser(data.inv[2])), (data.inv[3] && deser(data.inv[3]))];
                    existing.userData.fuelRemaining = data.fuelRemaining || 0;
                    existing.userData.cookProgress = data.cookProgress || 0;
                }
                continue;
            }
            let mesh;
            if (campfireModel && campfireModel.isObject3D) {
                mesh = campfireModel.clone(true);
            } else {
                const geom = new THREE.BoxGeometry(0.7, 0.7, 0.7);
                const mat = new THREE.MeshStandardMaterial({ color: 0xff9933 });
                mesh = new THREE.Mesh(geom, mat);
            }
            mesh.visible = true;
            mesh.userData.isCampfire = true;
            mesh.traverse((c) => {
                if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.userData.isCampfire = true; }
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

            mesh.position.set(data.x + 0.5 - center.x, data.y - modelBottom, data.z + 0.5 - center.z);

            scene.add(mesh);
            mesh.updateMatrixWorld(true);
            mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            mesh.userData.campfireX = data.x;
            mesh.userData.campfireY = data.y;
            mesh.userData.campfireZ = data.z;
            const deser = (s) => (s == null ? null : (typeof s === 'object' ? createStackItem(s.type, s.count) : s));
            mesh.userData.campfireInventory = data.inv && data.inv.length >= 4
                ? [(data.inv[0] && deser(data.inv[0])), (data.inv[1] && deser(data.inv[1])), (data.inv[2] && deser(data.inv[2])), (data.inv[3] && deser(data.inv[3]))]
                : data.inv && data.inv.length === 3
                    ? [(data.inv[0] && deser(data.inv[0])), (data.inv[1] && deser(data.inv[1])), (data.inv[2] && deser(data.inv[2])), null]
                    : [null, null, null, null];
            mesh.userData.fuelRemaining = data.fuelRemaining || 0;
            mesh.userData.cookProgress = data.cookProgress || 0;
            campfires.push(mesh);
            const chunkCampfires = campfiresByChunk.get(chunkKey) || [];
            chunkCampfires.push(mesh);
            campfiresByChunk.set(chunkKey, chunkCampfires);
        }
    }

    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkCampfires = campfiresByChunk.get(chunkKey) || [];
        for (const mesh of chunkCampfires) {
            if (mesh && scene.children.includes(mesh)) scene.remove(mesh);
        }
        saveCampfireData();
        campfiresByChunk.delete(chunkKey);
    }

    function updateVisibility(loadedChunkKeys) {
        for (const [chunkKey, chunkCampfires] of campfiresByChunk.entries()) {
            const isLoaded = loadedChunkKeys.has(chunkKey);
            for (const mesh of chunkCampfires) {
                if (isLoaded && !scene.children.includes(mesh)) scene.add(mesh);
                else if (!isLoaded && scene.children.includes(mesh)) scene.remove(mesh);
            }
        }
    }

    function getStateForSave() {
        const chunkSize = terrain.chunkSize || 16;
        const allData = {};
        for (const mesh of campfires) {
            initCampfireState(mesh);
            const inv = mesh.userData.campfireInventory;
            const ser = (s) => (s == null ? null : (typeof s === 'object' ? { type: s.type, count: s.count } : s));
            const cx = Math.floor(mesh.userData.campfireX / chunkSize);
            const cz = Math.floor(mesh.userData.campfireZ / chunkSize);
            const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            if (!allData[chunkKey]) allData[chunkKey] = [];
            allData[chunkKey].push({
                x: mesh.userData.campfireX,
                y: mesh.userData.campfireY,
                z: mesh.userData.campfireZ,
                inv: [ser(inv[0]), ser(inv[1]), ser(inv[2]), ser(inv[3])],
                fuelRemaining: mesh.userData.fuelRemaining,
                cookProgress: mesh.userData.cookProgress
            });
        }
        return allData;
    }

    function restoreFromSave(allData) {
        for (const mesh of campfires.slice()) {
            if (scene.children.includes(mesh)) scene.remove(mesh);
        }
        campfires.length = 0;
        campfiresByChunk.clear();
        if (!allData || typeof allData !== 'object') return;
        const deser = (s) => (s == null ? null : (typeof s === 'object' ? createStackItem(s.type, s.count) : s));
        for (const [chunkKey, chunkData] of Object.entries(allData)) {
            if (!Array.isArray(chunkData)) continue;
            for (const data of chunkData) {
                let mesh;
                if (campfireModel && campfireModel.isObject3D) {
                    mesh = campfireModel.clone(true);
                } else {
                    const geom = new THREE.BoxGeometry(0.7, 0.7, 0.7);
                    const mat = new THREE.MeshStandardMaterial({ color: 0xff9933 });
                    mesh = new THREE.Mesh(geom, mat);
                }
                mesh.visible = true;
                mesh.userData.isCampfire = true;
                mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.userData.isCampfire = true; } });

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

                mesh.position.set(data.x + 0.5 - center.x, data.y - modelBottom, data.z + 0.5 - center.z);

                scene.add(mesh);
                mesh.updateMatrixWorld(true);
                mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
                mesh.userData.campfireX = data.x;
                mesh.userData.campfireY = data.y;
                mesh.userData.campfireZ = data.z;
                mesh.userData.campfireInventory = data.inv && data.inv.length >= 4
                    ? [(data.inv[0] && deser(data.inv[0])), (data.inv[1] && deser(data.inv[1])), (data.inv[2] && deser(data.inv[2])), (data.inv[3] && deser(data.inv[3]))]
                    : data.inv && data.inv.length === 3
                        ? [(data.inv[0] && deser(data.inv[0])), (data.inv[1] && deser(data.inv[1])), (data.inv[2] && deser(data.inv[2])), null]
                        : [null, null, null, null];
                mesh.userData.fuelRemaining = data.fuelRemaining || 0;
                mesh.userData.cookProgress = data.cookProgress || 0;
                campfires.push(mesh);
                const chunkCampfires = campfiresByChunk.get(chunkKey) || [];
                chunkCampfires.push(mesh);
                campfiresByChunk.set(chunkKey, chunkCampfires);
            }
        }
        saveCampfireData();
    }

    return {
        placeCampfire,
        getCampfireAt,
        removeCampfire,
        campfires,
        getCampfireInventory,
        setCampfireInventory,
        getFuelRemaining,
        getCookProgress,
        update,
        onChunkLoad,
        onChunkUnload,
        updateVisibility,
        getStateForSave,
        restoreFromSave,
    };
}
