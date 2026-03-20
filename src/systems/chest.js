// Chest system: place, interact, store items

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../assets/assetBase.js';

export const CHEST_SLOTS = 15; // 3 rows × 5 cells

export function createChestSystem(scene, terrain, player, backpackSlots, createStackItem, chestModelFromLoader = null) {
    const chests = [];
    const chestInventories = new Map(); // key: chest mesh, value: array of CHEST_SLOTS
    const chestsByChunk = new Map(); // key: chunk key, value: array of chest meshes
    const chestDataByChunk = new Map(); // key: chunk key, value: array of chest data (for persistence)

    // Use provided model or load our own
    let chestModel = chestModelFromLoader;
    if (!chestModel) {
        const loader = new GLTFLoader();
        loader.load(ASSET_BASE + 'models/chest.glb', (gltf) => {
            chestModel = gltf.scene;
        });
    }

    function placeChest(x, y, z) {
        let mesh;
        
        // Try to use the loaded model
        if (chestModel && chestModel.isObject3D) {
            // Deep clone the model - this preserves all child transforms
            mesh = chestModel.clone(true);
            // Only reset the root transform (children keep their relative positions)
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            
            // Check model size and scale to approximately 1 block (1 unit)
            // This ensures the model is properly sized regardless of how it was exported
            mesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(mesh);
            const size = bbox.getSize(new THREE.Vector3());
            const maxSize = Math.max(size.x, size.y, size.z);
            
            // Scale model so its largest dimension is approximately 1 unit (1 block)
            // This makes the model visible and properly sized in the world
            if (maxSize > 0.01) { // Avoid division by zero
                const targetSize = 1.0; // Target size of 1 block (1 unit)
                const scaleFactor = targetSize / maxSize;
                mesh.scale.set(scaleFactor, scaleFactor, scaleFactor);
            } else {
                // Fallback: use natural scale if size calculation fails
                mesh.scale.set(1, 1, 1);
            }
            // DO NOT reset child transforms - they define the model structure!
        } else {
            // Fallback: use a simple colored cube
            const geom = new THREE.BoxGeometry(0.8, 0.8, 0.8);
            const mat = new THREE.MeshStandardMaterial({ color: 0xcc9966 });
            mesh = new THREE.Mesh(geom, mat);
        }

        mesh.visible = true;
        mesh.userData.isChest = true;
        
        // Set userData on all children so raycasting works
        mesh.traverse((c) => { 
            if (c.isMesh) { 
                c.castShadow = true; 
                c.receiveShadow = true;
                // Ensure all children have the chest flag for raycasting
                c.userData.isChest = true;
            } 
        });
        
        // Calculate bounding box in local space (before positioning) to find the bottom of the model
        // Position mesh at origin temporarily to get accurate local bounding box
        mesh.position.set(0, 0, 0);
        mesh.updateMatrixWorld(true);
        const localBbox = new THREE.Box3().setFromObject(mesh);
        const modelBottom = localBbox.min.y; // Bottom of model in local space (relative to mesh origin)
        
        // Position in world - center X and Z, align bottom of model with bottom of block
        // The block bottom is at y, so we need: mesh.position.y + modelBottom = y
        // Therefore: mesh.position.y = y - modelBottom
        mesh.position.set(x + 0.5, y - modelBottom, z + 0.5);
        
        // Add to scene (placement only happens in loaded chunks)
        scene.add(mesh);
        
        // Update matrix and collision box after positioning
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        
        chests.push(mesh);
        chestInventories.set(mesh, new Array(CHEST_SLOTS).fill(null));
        
        // Register chest to chunk
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkChests = chestsByChunk.get(chunkKey) || [];
        chunkChests.push(mesh);
        chestsByChunk.set(chunkKey, chunkChests);
        
        // Store chest position in userData for persistence
        mesh.userData.chestX = x;
        mesh.userData.chestY = y;
        mesh.userData.chestZ = z;
        
        // Add to scene (placement only happens in loaded chunks)
        scene.add(mesh);
        
        // Save to localStorage
        saveChestData();
        
        return mesh;
    }

    function getChestAt(pos) {
        for (const mesh of chests) {
            if (mesh.position.distanceTo(pos) < 1.2) return mesh;
        }
        return null;
    }

    function removeChest(mesh) {
        // Remove from scene
        scene.remove(mesh);
        
        // Remove from chests array
        const idx = chests.indexOf(mesh);
        if (idx !== -1) chests.splice(idx, 1);
        
        // Remove from chunk tracking
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(mesh.userData.chestX / chunkSize);
        const cz = Math.floor(mesh.userData.chestZ / chunkSize);
        const chunkKey = `${cx},${cz}`;
        const chunkChests = chestsByChunk.get(chunkKey);
        if (chunkChests) {
            const chunkIdx = chunkChests.indexOf(mesh);
            if (chunkIdx !== -1) chunkChests.splice(chunkIdx, 1);
            if (chunkChests.length === 0) {
                chestsByChunk.delete(chunkKey);
            }
        }
        
        // Remove inventory
        chestInventories.delete(mesh);
        
        // Save to localStorage
        saveChestData();
    }

    function getInventory(mesh) {
        let inventory = chestInventories.get(mesh);
        if (!inventory) {
            inventory = new Array(CHEST_SLOTS).fill(null);
            chestInventories.set(mesh, inventory);
        }
        return inventory;
    }

    function setInventory(mesh, inventory) {
        chestInventories.set(mesh, inventory);
        // Save to localStorage when inventory changes
        saveChestData();
    }

    // Save all chest data to localStorage
    function saveChestData() {
        const allChestData = {};
        for (const [chunkKey, chunkChests] of chestsByChunk.entries()) {
            const chestData = [];
            for (const mesh of chunkChests) {
                const inventory = chestInventories.get(mesh) || new Array(CHEST_SLOTS).fill(null);
                chestData.push({
                    x: mesh.userData.chestX,
                    y: mesh.userData.chestY,
                    z: mesh.userData.chestZ,
                    inventory: inventory.map(slot => slot ? { type: slot.type, count: slot.count } : null)
                });
            }
            if (chestData.length > 0) {
                allChestData[chunkKey] = chestData;
            }
        }
        try {
            localStorage.setItem('voxelChests', JSON.stringify(allChestData));
        } catch (e) {
        }
    }

    // Load chest data from localStorage
    function loadChestData() {
        try {
            const saved = localStorage.getItem('voxelChests');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
        }
        return {};
    }

    // Called when a chunk is loaded
    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        
        // Load saved chest data for this chunk
        const savedData = loadChestData();
        const chunkData = savedData[chunkKey] || [];
        
        for (const data of chunkData) {
            // Check if chest already exists (avoid duplicates)
            const existing = chests.find(c => 
                c.userData.chestX === data.x && 
                c.userData.chestY === data.y && 
                c.userData.chestZ === data.z
            );
            if (existing) {
                // Chest exists, just make sure it's visible and in the scene
                if (!scene.children.includes(existing)) {
                    scene.add(existing);
                }
                // Restore inventory if needed (normalize to CHEST_SLOTS)
                if (data.inventory) {
                    const raw = data.inventory.map(slot => 
                        slot ? createStackItem(slot.type, slot.count) : null
                    );
                    const inventory = new Array(CHEST_SLOTS).fill(null);
                    for (let i = 0; i < Math.min(raw.length, CHEST_SLOTS); i++) inventory[i] = raw[i];
                    chestInventories.set(existing, inventory);
                }
                continue;
            }
            
            // Create new chest mesh (similar to placeChest but don't add to scene yet)
            let mesh;
            if (chestModel && chestModel.isObject3D) {
                mesh = chestModel.clone(true);
                mesh.position.set(0, 0, 0);
                mesh.rotation.set(0, 0, 0);
                
                // Check model size and scale to approximately 1 block (1 unit)
                mesh.updateMatrixWorld(true);
                const bbox = new THREE.Box3().setFromObject(mesh);
                const size = bbox.getSize(new THREE.Vector3());
                const maxSize = Math.max(size.x, size.y, size.z);
                
                // Scale model so its largest dimension is approximately 1 unit (1 block)
                if (maxSize > 0.01) { // Avoid division by zero
                    const targetSize = 1.0; // Target size of 1 block (1 unit)
                    const scaleFactor = targetSize / maxSize;
                    mesh.scale.set(scaleFactor, scaleFactor, scaleFactor);
                } else {
                    mesh.scale.set(1, 1, 1);
                }
            } else {
                const geom = new THREE.BoxGeometry(0.8, 0.8, 0.8);
                const mat = new THREE.MeshStandardMaterial({ color: 0xcc9966 });
                mesh = new THREE.Mesh(geom, mat);
            }
            
            mesh.visible = true;
            mesh.userData.isChest = true;
            mesh.traverse((c) => { 
                if (c.isMesh) { 
                    c.castShadow = true; 
                    c.receiveShadow = true;
                    c.userData.isChest = true;
                } 
            });
            
            // Calculate position
            mesh.position.set(0, 0, 0);
            mesh.updateMatrixWorld(true);
            const localBbox = new THREE.Box3().setFromObject(mesh);
            const modelBottom = localBbox.min.y;
            mesh.position.set(data.x + 0.5, data.y - modelBottom, data.z + 0.5);
            
            // Add to scene
            scene.add(mesh);
            mesh.updateMatrixWorld(true);
            mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            
            // Store position
            mesh.userData.chestX = data.x;
            mesh.userData.chestY = data.y;
            mesh.userData.chestZ = data.z;
            
            // Add to arrays
            chests.push(mesh);
            
            // Restore inventory (normalize to CHEST_SLOTS)
            const raw = (data.inventory || []).map(slot => 
                slot ? createStackItem(slot.type, slot.count) : null
            );
            const inventory = new Array(CHEST_SLOTS).fill(null);
            for (let i = 0; i < Math.min(raw.length, CHEST_SLOTS); i++) inventory[i] = raw[i];
            chestInventories.set(mesh, inventory);
            
            // Register to chunk
            const chunkChests = chestsByChunk.get(chunkKey) || [];
            chunkChests.push(mesh);
            chestsByChunk.set(chunkKey, chunkChests);
            
            // Add to scene since chunk is being loaded
            scene.add(mesh);
        }
    }

    // Called when a chunk is unloaded
    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkChests = chestsByChunk.get(chunkKey) || [];
        
        // Hide and save chests in this chunk
        for (const mesh of chunkChests) {
            // Remove from scene if it's still there
            if (mesh && scene.children.includes(mesh)) {
                scene.remove(mesh);
            }
            // Note: We keep the mesh in the chests array and chestInventories for persistence
        }
        
        // Save data before clearing chunk
        saveChestData();
        chestsByChunk.delete(chunkKey);
    }

    // Get chests in a specific chunk (for visibility management)
    function getChestsInChunk(cx, cz) {
        const chunkKey = `${cx},${cz}`;
        return chestsByChunk.get(chunkKey) || [];
    }

    // Return full chest state for game save (all chests, by chunk key)
    function getStateForSave() {
        const chunkSize = terrain.chunkSize || 16;
        const allChestData = {};
        for (const mesh of chests) {
            const inventory = chestInventories.get(mesh) || new Array(CHEST_SLOTS).fill(null);
            const cx = Math.floor(mesh.userData.chestX / chunkSize);
            const cz = Math.floor(mesh.userData.chestZ / chunkSize);
            const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            if (!allChestData[chunkKey]) allChestData[chunkKey] = [];
            allChestData[chunkKey].push({
                x: mesh.userData.chestX,
                y: mesh.userData.chestY,
                z: mesh.userData.chestZ,
                inventory: inventory.map(slot => slot ? { type: slot.type, count: slot.count } : null)
            });
        }
        return allChestData;
    }

    // Clear all chests and restore from saved state (per-save slot)
    function restoreFromSave(allData) {
        for (const mesh of chests.slice()) {
            if (scene.children.includes(mesh)) scene.remove(mesh);
            chestInventories.delete(mesh);
        }
        chests.length = 0;
        chestsByChunk.clear();
        if (!allData || typeof allData !== 'object') return;
        for (const [chunkKey, chunkData] of Object.entries(allData)) {
            if (!Array.isArray(chunkData)) continue;
            for (const data of chunkData) {
                let mesh;
                if (chestModel && chestModel.isObject3D) {
                    mesh = chestModel.clone(true);
                    mesh.position.set(0, 0, 0);
                    mesh.rotation.set(0, 0, 0);
                    mesh.updateMatrixWorld(true);
                    const bbox = new THREE.Box3().setFromObject(mesh);
                    const size = bbox.getSize(new THREE.Vector3());
                    const maxSize = Math.max(size.x, size.y, size.z);
                    if (maxSize > 0.01) mesh.scale.setScalar(1 / maxSize);
                    else mesh.scale.set(1, 1, 1);
                } else {
                    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0xcc9966 }));
                }
                mesh.visible = true;
                mesh.userData.isChest = true;
                mesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.userData.isChest = true; } });
                mesh.position.set(0, 0, 0);
                mesh.updateMatrixWorld(true);
                const localBbox = new THREE.Box3().setFromObject(mesh);
                const modelBottom = localBbox.min.y;
                mesh.position.set(data.x + 0.5, data.y - modelBottom, data.z + 0.5);
                scene.add(mesh);
                mesh.updateMatrixWorld(true);
                mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
                mesh.userData.chestX = data.x;
                mesh.userData.chestY = data.y;
                mesh.userData.chestZ = data.z;
                const raw = (data.inventory || []).map(slot => slot ? createStackItem(slot.type, slot.count) : null);
                const inventory = new Array(CHEST_SLOTS).fill(null);
                for (let i = 0; i < Math.min(raw.length, CHEST_SLOTS); i++) inventory[i] = raw[i];
                chestInventories.set(mesh, inventory);
                chests.push(mesh);
                const chunkChests = chestsByChunk.get(chunkKey) || [];
                chunkChests.push(mesh);
                chestsByChunk.set(chunkKey, chunkChests);
            }
        }
    }

    // Update visibility of chests based on loaded chunks
    function updateVisibility(loadedChunkKeys) {
        for (const [chunkKey, chunkChests] of chestsByChunk.entries()) {
            const isLoaded = loadedChunkKeys.has(chunkKey);
            for (const mesh of chunkChests) {
                if (isLoaded && !scene.children.includes(mesh)) {
                    scene.add(mesh);
                } else if (!isLoaded && scene.children.includes(mesh)) {
                    scene.remove(mesh);
                }
            }
        }
    }

    return {
        placeChest,
        getChestAt,
        getInventory,
        setInventory,
        removeChest,
        chests,
        onChunkLoad,
        onChunkUnload,
        updateVisibility,
        getChestsInChunk,
        getStateForSave,
        restoreFromSave,
    };
}
