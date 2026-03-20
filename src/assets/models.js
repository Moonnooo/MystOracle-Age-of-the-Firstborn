// src/assets/models.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from './assetBase.js';

// Centralized model paths (use ASSET_BASE so packaged build finds files)
export const MODEL_PATHS = {
    character: ASSET_BASE + 'models/character.glb',
    gun: ASSET_BASE + 'models/gun.glb',
    bow: ASSET_BASE + 'models/bow.glb',
    pickaxe: ASSET_BASE + 'models/pickaxe.glb',
    axe: ASSET_BASE + 'models/axe.glb',
    campfire: ASSET_BASE + 'models/campfire.glb',
    chest: ASSET_BASE + 'models/chest.glb',
    furnace: ASSET_BASE + 'models/furnace.glb',
    loom: ASSET_BASE + 'models/loom.glb',
    bed: ASSET_BASE + 'models/bed.glb',
    tree: ASSET_BASE + 'models/tree.glb',
    stone_pebbles: ASSET_BASE + 'models/stone_pebbles.glb',
    little_rambling: ASSET_BASE + 'models/little_rambling.glb',
    stump: ASSET_BASE + 'models/tree_stump.glb',
    food: ASSET_BASE + 'models/food.glb',
    stick: ASSET_BASE + 'models/stick.glb',
    spade: ASSET_BASE + 'models/spade.glb',
    bone: ASSET_BASE + 'models/bone.glb',
    // Used for ore decorations (also re-used by itemDrops currently for ore pickups).
    iron_ore: ASSET_BASE + 'models/iron_ore.glb',
};

const loader = new GLTFLoader();

function setupModel(name, object, player, camera) {
    // Custom setup per model
    if (name === 'character') {
        object.visible = false;
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (player) player.add(object);
    } else if (name === 'gun') {
        object.scale.set(0.52, 0.52, 0.52);
        object.position.set(0.28, -0.40, -0.52);
        object.rotation.set(-0.38, 0.18, 0.08);
        object.visible = false;
        object.userData.heldType = 'gun';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'pickaxe') {
        object.scale.set(0.52, 0.52, 0.52);
        object.position.set(0.30, -0.46, -0.50);
        object.rotation.set(-0.92, 0.26, 0.12);
        object.visible = false;
        object.userData.heldType = 'pickaxe';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'bow') {
        // Bow weapon model attached to camera; arrows are fired by logic in renderer.
        object.scale.set(0.52, 0.52, 0.52);
        object.position.set(0.29, -0.43, -0.53);
        object.rotation.set(-0.44, 0.14, Math.PI);
        object.visible = false;
        object.userData.heldType = 'bow';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'axe') {
        object.scale.set(0.52, 0.52, 0.52);
        object.position.set(0.30, -0.46, -0.50);
        object.rotation.set(-0.88, 0.24, 0.10);
        object.visible = false;
        object.userData.heldType = 'axe';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'campfire') {
        object.scale.set(0.3, 0.3, 0.3);
        object.position.set(0.2, -0.5, -0.5);
        object.visible = false;
        object.userData.heldType = 'campfire';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'chest') {
        object.scale.set(0.4, 0.4, 0.4);
        object.position.set(0.2, -0.5, -0.5);
        object.rotation.set(0, 0.3, 0);
        object.visible = false;
        object.userData.heldType = 'chest';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'furnace') {
        object.scale.set(0.4, 0.4, 0.4);
        object.position.set(0.2, -0.5, -0.5);
        object.rotation.set(0, 0.2, 0);
        object.visible = false;
        object.userData.heldType = 'furnace';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'loom') {
        object.scale.set(0.4, 0.4, 0.4);
        object.position.set(0.2, -0.5, -0.5);
        object.rotation.set(0, 0.2, 0);
        object.visible = false;
        object.userData.heldType = 'loom';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'bed') {
        object.scale.set(0.5, 0.5, 0.5);
        object.position.set(0.25, -0.5, -0.55);
        object.rotation.set(0, 0.2, 0);
        object.visible = false;
        object.userData.heldType = 'bed';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'stick') {
        object.scale.set(0.4, 0.4, 0.4);
        object.position.set(0.25, -0.35, -0.45);
        object.rotation.set(-0.4, 0.1, 0);
        object.visible = false;
        object.userData.heldType = 'stick';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'spade') {
        // Tool overlay attached to the camera (like pickaxe).
        // Mirror on local Y so handle/blade swap without orbiting the held pose.
        object.scale.set(0.52, -0.52, 0.52);
        // Recenter local pivot so flips rotate the shovel itself in place
        // instead of orbiting around an offset import origin.
        object.position.set(0, 0, 0);
        object.rotation.set(0, 0, 0);
        object.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        object.position.sub(center);
        // Keep the same held spot in view.
        object.position.add(new THREE.Vector3(0.31, -0.38, -0.46));
        // Keep the "180 feels right" held pose, but with mirrored model direction.
        object.rotation.set(-0.84, 0.24 + Math.PI, 0.08);
        object.visible = false;
        object.userData.heldType = 'spade';
        object.traverse((c) => {
            if (c.isMesh) {
                c.castShadow = true;
                c.receiveShadow = true;
                if (c.material) c.material.side = THREE.DoubleSide;
            }
        });
        if (camera) camera.add(object);
    } else if (name === 'food') {
        object.scale.set(0.35, 0.35, 0.35);
        object.position.set(0.2, -0.4, -0.5);
        object.rotation.set(-0.3, 0.15, 0);
        object.visible = false;
        object.userData.heldType = 'food';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    } else if (name === 'bone') {
        object.scale.set(0.4, 0.4, 0.4);
        object.position.set(0.25, -0.35, -0.45);
        object.rotation.set(-0.4, 0.1, 0);
        object.visible = false;
        object.userData.heldType = 'bone';
        object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        if (camera) camera.add(object);
    }
}

/**
 * Loads all models defined in MODEL_PATHS.
 * Returns a promise resolving to an object: { [name]: THREE.Group }
 * Optionally attaches character/gun/pickaxe to player/camera.
 */
export async function loadModels(player, camera) {
    const entries = Object.entries(MODEL_PATHS);
    const promises = entries.map(([name, path]) =>
        loader.loadAsync(path)
            .then(gltf => ({ name, object: gltf.scene }))
            .catch(err => {
                return { name, object: null };
            })
    );
    const results = await Promise.all(promises);
    const models = {};
    results.forEach(({ name, object }) => {
        if (object) {
            // For chest and campfire, clone BEFORE setupModel modifies them
            // This gives us a clean copy for world placement
            if (name === 'chest' || name === 'campfire' || name === 'furnace' || name === 'loom' || name === 'bed' || name === 'tree' || name === 'stone_pebbles' || name === 'stump' || name === 'food' || name === 'stick' || name === 'bone') {
                // Clone for world/drops (stump, tree, food, stick, bone) or world + held (chest, campfire, bed, food, stick, bone)
                models[name] = object.clone(true);
                if (name !== 'tree' && name !== 'stone_pebbles' && name !== 'stump') setupModel(name, object, player, camera);
            } else {
                // For other models, just use directly
                models[name] = object;
                setupModel(name, object, player, camera);
            }
        } else {
            models[name] = null;
        }
    });
    return models;
}
