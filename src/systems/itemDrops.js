import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../assets/assetBase.js';

// Item drop system: floating/spinning drops. Uses essence.glb for essence type, cube placeholder for others.

export function createItemDropSystem(scene, terrain, getPlayer, onPickup, onDespawnWarning, onDespawnComplete) {
    const drops = [];
    const PICKUP_RADIUS = 1.6;
    const SPIN_SPEED = 1.2; // radians/sec (slow spin so drops are readable)
    const BOB_SPEED = 4;
    const BOB_HEIGHT = 0.12; // gentle bob so items hover just above the block
    const STACK_RADIUS = 3.0; // world units for stacking nearby same-type drops

    // World-item clear timer:
    // Instead of despawning each drop independently (which causes frequent warnings),
    // we run a single global "clear all drops" timer whenever the world has drops.
    const DESPAWN_TIME = 60; // seconds until all world drops are cleared
    const DESPAWN_WARNING_LEAD = 10; // seconds before clear to warn the player
    let worldClearTimeSeconds = null; // when to clear all drops (absolute time in seconds)
    let worldClearWarningActive = false;

    function nowSeconds() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() / 1000
            : Date.now() / 1000;
    }

    let essenceModel = null;
    let foodModel = null;
    let stickModel = null;
    let boneModel = null;
    let oreModel = null; // used for iron_ore, coal, gold_ore drops until custom models exist
    const loader = new GLTFLoader();
    loader.load(ASSET_BASE + 'models/essence.glb', (gltf) => {
        const model = gltf.scene;
        model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        essenceModel = model;
    }, undefined, () => { essenceModel = null; });
    // Fallback load for bone so drops show the model even if main loader hasn't run or failed
    loader.load(ASSET_BASE + 'models/bone.glb', (gltf) => {
        const model = gltf.scene;
        model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        boneModel = model;
    }, undefined, () => {});

    // Load iron ore model – reused for all ore-type item drops (iron_ore, coal, gold_ore) for now.
    loader.load(ASSET_BASE + 'models/iron_ore.glb', (gltf) => {
        const model = gltf.scene;
        model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        oreModel = model;
    }, undefined, () => {});

    function makeDropFromModel(sourceModel, type) {
        if (!sourceModel || !sourceModel.isObject3D) return null;
        const clone = sourceModel.clone(true);
        clone.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(clone);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        const scale = 0.55 / maxDim;
        clone.scale.setScalar(scale);
        clone.position.sub(center.multiplyScalar(scale));
        const group = new THREE.Group();
        group.add(clone);
        group.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        group.userData.isItemDrop = true;
        group.userData.dropType = type;
        return group;
    }

    function createDropMesh(type, color) {
        if (type === 'essence' && essenceModel) {
            const group = makeDropFromModel(essenceModel, type);
            if (group) return group;
        }
        const foodTypes = ['raw_beef', 'cooked_beef', 'raw_mutton', 'cooked_mutton'];
        if (foodTypes.includes(type) && foodModel) {
            const group = makeDropFromModel(foodModel, type);
            if (group) return group;
        }
        if (type === 'stick' && stickModel) {
            const group = makeDropFromModel(stickModel, type);
            if (group) return group;
        }
        if (type === 'bone' && boneModel) {
            const group = makeDropFromModel(boneModel, type);
            if (group) return group;
        }
        // Use iron ore model for all ore drops until dedicated models exist.
        if ((type === 'iron_ore' || type === 'coal' || type === 'gold_ore') && oreModel) {
            const group = makeDropFromModel(oreModel, type);
            if (group) return group;
        }

        // Terrain block drop: use the block's atlas texture if available
        const blockType = typeof type === 'number' ? type : (type === 'stone' ? 2 : type === 'coal' ? 7 : type === 'iron_ore' ? 8 : null);
        const atlasTexture = terrain && typeof terrain.getTerrainAtlasTexture === 'function' ? terrain.getTerrainAtlasTexture() : null;
        const tile = (blockType != null && terrain && typeof terrain.getBlockDropTile === 'function') ? terrain.getBlockDropTile(blockType) : null;
        const faceTiles = (blockType != null && terrain && typeof terrain.getBlockDropFaceTiles === 'function')
            ? terrain.getBlockDropFaceTiles(blockType)
            : null;

        if (atlasTexture && (faceTiles != null || tile != null)) {
            const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
            const uvs = geo.attributes.uv.array;
            const tileU = (terrain && typeof terrain.getAtlasTileU === 'function') ? terrain.getAtlasTileU() : 1 / 16;
            // BoxGeometry face order: +X, -X, +Y (top), -Y (bottom), +Z, -Z — 6 vertices (12 UVs) per face
            const UVS_PER_FACE = 12;
            const tileByFace = faceTiles ?? [tile, tile, tile, tile, tile, tile];
            for (let face = 0; face < 6; face++) {
                const faceTile = tileByFace[face];
                const u0 = faceTile * tileU;
                const start = face * UVS_PER_FACE;
                for (let i = start; i < start + UVS_PER_FACE; i += 2) {
                    const u = uvs[i];
                    uvs[i] = u0 + u * tileU;
                }
            }
            geo.attributes.uv.needsUpdate = true;
            const mat = new THREE.MeshStandardMaterial({
                map: atlasTexture,
                color: 0xffffff,
                metalness: 0.0,
                roughness: 0.3,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.userData.isItemDrop = true;
            mesh.userData.dropType = type;
            return mesh;
        }

        const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(...color),
            emissive: new THREE.Color(color[0] * 0.4, color[1] * 0.4, color[2] * 0.4),
            metalness: 0.0,
            roughness: 0.3,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isItemDrop = true;
        mesh.userData.dropType = type;
        return mesh;
    }

    function disposeMesh(mesh) {
        if (!mesh) return;
        mesh.traverse((c) => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) {
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material.dispose();
            }
        });
    }

    function createCountLabelSprite(text) {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.clearRect(0, 0, size, size);
        ctx.font = 'bold 60px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(size * 0.5 - 40, size * 0.5 - 30, 80, 60);
        ctx.fillStyle = 'white';
        ctx.fillText(String(text), size / 2, size / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.6, 0.3, 1);
        return sprite;
    }

    function updateDropLabel(drop) {
        if (drop.label) {
            drop.mesh.remove(drop.label);
            if (drop.label.material && drop.label.material.map) {
                drop.label.material.map.dispose();
            }
            if (drop.label.material) drop.label.material.dispose();
            drop.label = null;
        }
        if (drop.count <= 1) return;
        const sprite = createCountLabelSprite(drop.count);
        if (!sprite) return;
        sprite.position.set(0, 0.6, 0);
        drop.mesh.add(sprite);
        drop.label = sprite;
    }

    function getColorForType(type) {
        // Very simple placeholder colors; tune as you go.
        if (type === 'wood') return [0.55, 0.35, 0.2];
        if (type === 'planks') return [0.7, 0.55, 0.35];
        if (type === 'stick') return [0.6, 0.45, 0.25];
        if (type === 'string') return [0.95, 0.9, 0.85];
        if (type === 'spares') return [0.5, 0.45, 0.4];
        if (type === 'arrow') return [0.5, 0.4, 0.3];
        if (type === 'feathered_arrow') return [0.9, 0.9, 0.95];
        if (type === 'loom') return [0.55, 0.45, 0.35];
        if (type === 'wool') return [1, 1, 1];
        if (type === 'sapling') return [0.2, 0.6, 0.2];
        if (type === 'stone') return [0.5, 0.5, 0.5];
        if (type === 'coal') return [0.15, 0.15, 0.15];
        if (type === 'iron_ore') return [0.45, 0.35, 0.3];
        if (type === 'iron_bar') return [0.6, 0.55, 0.5];
        if (type === 'leaf' || type === 'leaves') return [0.2, 0.8, 0.2];
        if (type === 'essence') return [0.5, 0.1, 0.8];
        if (type === 'raw_beef') return [0.6, 0.1, 0.1];
        if (type === 'raw_mutton') return [0.9, 0.8, 0.8];
        if (typeof type === 'number') {
            // Numeric block IDs: dirt/stone/grass, etc.
            if (type === 1) return [0.55, 0.27, 0.07];
            if (type === 2) return [0.5, 0.5, 0.5];
            if (type === 3) return [0.2, 0.8, 0.2];
            if (type === 9) return [0.95, 0.9, 0.4];
            if (type === 10) return [0.25, 0.8, 0.25];
        }
        return [0.9, 0.9, 0.9]; // generic
    }

    function spawnDrop(type, count, position) {
        if (count <= 0) return;

        // Try to stack with an existing nearby drop of the same type
        for (const drop of drops) {
            if (drop.type !== type) continue;
            const dx = drop.mesh.position.x - position.x;
            const dy = drop.mesh.position.y - position.y;
            const dz = drop.mesh.position.z - position.z;
            const distSq = dx*dx + dy*dy + dz*dz;
            if (distSq <= STACK_RADIUS * STACK_RADIUS) {
                drop.count += count;
                updateDropLabel(drop);
                return;
            }
        }

        // Use spawn position Y. Only snap to terrain surface when the spawn is above the surface
        // (e.g. mob drop from above); block-break drops underground must stay at the break position.
        let groundY = position.y;
        if (terrain && typeof terrain.getSurfaceYAt === 'function') {
            const s = terrain.getSurfaceYAt(position.x, position.z);
            if (s >= 0) {
                const surfaceTop = s + 1;
                if (position.y > surfaceTop) {
                    groundY = surfaceTop; // was above ground, land on surface
                }
            }
        }

        // Create a new drop so at the bottom of its bob the cube never clips into terrain
        const color = getColorForType(type);
        const mesh = createDropMesh(type, color);
        const cubeHalf = 0.55 / 2;
        const clearance = 0.02;
        const baseY = groundY + cubeHalf + BOB_HEIGHT + clearance;
        mesh.position.set(position.x, baseY, position.z);
        scene.add(mesh);
        const drop = {
            mesh,
            type,
            count,
            baseY,
            age: 0,
            label: null,
        };
        drops.push(drop);
        // Start a single global clear timer when the first drop appears.
        // This prevents the "world drops will clear in 10 seconds" warning
        // from popping repeatedly for each individual drop.
        if (drops.length === 1) {
            worldClearTimeSeconds = nowSeconds() + DESPAWN_TIME;
            worldClearWarningActive = false;
        }
        updateDropLabel(drop);
    }

    const PICKUP_DELAY = 0.2; // seconds before a freshly spawned drop can be picked up
    const CUBE_HALF = 0.55 / 2;
    const DROP_GRAVITY = 22;
    const FEET_OFFSET = CUBE_HALF + BOB_HEIGHT; // bottom of drop (lowest point of bob)

    function update(delta) {
        const player = getPlayer && getPlayer();
        if (!player) return;

        const playerPos = player.position;

        // Global clear timer for world drops.
        // Warn once shortly before clearing, then clear all drops together.
        const now = nowSeconds();
        if (worldClearTimeSeconds != null && drops.length === 0) {
            worldClearTimeSeconds = null;
            worldClearWarningActive = false;
        }
        if (worldClearTimeSeconds != null) {
            const warnAt = worldClearTimeSeconds - DESPAWN_WARNING_LEAD;
            if (!worldClearWarningActive && now >= warnAt) {
                worldClearWarningActive = true;
                if (typeof onDespawnWarning === 'function') onDespawnWarning(DESPAWN_WARNING_LEAD);
            }

            if (now >= worldClearTimeSeconds) {
                // Actually clear all world drops at once.
                clearAll();
                if (typeof onDespawnComplete === 'function') onDespawnComplete();
                return;
            }
        }

        for (let i = drops.length - 1; i >= 0; i--) {
            const drop = drops[i];
            drop.age += delta;

            // Gravity: if no block below the drop, fall until we land
            if (terrain && typeof terrain.getVoxelAt === 'function') {
                const feetY = drop.baseY - FEET_OFFSET;
                const blockBelowY = Math.floor(feetY) - 1;
                const hasGround = blockBelowY >= 0 && terrain.getVoxelAt(drop.mesh.position.x, blockBelowY, drop.mesh.position.z) !== 0;

                if (!hasGround) {
                    if (drop.velocityY == null) drop.velocityY = 0;
                    drop.velocityY -= DROP_GRAVITY * delta;
                    drop.baseY += drop.velocityY * delta;
                    // Land: either we're inside a block (feet in solid) or just above solid
                    const newFeetY = drop.baseY - FEET_OFFSET;
                    const voxelAtFeet = Math.floor(newFeetY);
                    const blockAtFeet = voxelAtFeet >= 0 ? terrain.getVoxelAt(drop.mesh.position.x, voxelAtFeet, drop.mesh.position.z) : 0;
                    const blockBelow = voxelAtFeet - 1 >= 0 ? terrain.getVoxelAt(drop.mesh.position.x, voxelAtFeet - 1, drop.mesh.position.z) : 0;
                    let landTopY = null;
                    if (blockAtFeet !== 0) landTopY = voxelAtFeet + 1; // inside block, sit on top of it
                    else if (blockBelow !== 0) landTopY = voxelAtFeet;   // just above block
                    if (landTopY != null) {
                        drop.baseY = landTopY + FEET_OFFSET + 0.02;
                        drop.velocityY = 0;
                    }
                } else {
                    drop.velocityY = 0;
                }
            }

            // Spin and bob
            drop.mesh.rotation.y += SPIN_SPEED * delta;
            drop.mesh.position.y = drop.baseY + Math.sin(drop.age * BOB_SPEED) * BOB_HEIGHT;

            // Simple proximity pickup
            const dx = drop.mesh.position.x - playerPos.x;
            const dy = drop.mesh.position.y - playerPos.y;
            const dz = drop.mesh.position.z - playerPos.z;
            const distSq = dx*dx + dy*dy + dz*dz;
            if (drop.age < PICKUP_DELAY) continue;
            if (distSq < PICKUP_RADIUS * PICKUP_RADIUS) {
                let accepted = true;
                if (onPickup) {
                    accepted = onPickup(drop.type, drop.count) !== false;
                }
                if (!accepted) continue; // inventory had no room; leave drop in the world
                if (drop.label) {
                    drop.mesh.remove(drop.label);
                    if (drop.label.material && drop.label.material.map) {
                        drop.label.material.map.dispose();
                    }
                    if (drop.label.material) drop.label.material.dispose();
                }
                scene.remove(drop.mesh);
                disposeMesh(drop.mesh);
                drops.splice(i, 1);
            }
        }
    }

    function getCount() {
        return drops.length;
    }

    function clearAll() {
        for (const drop of drops) {
            if (drop.label) {
                drop.mesh.remove(drop.label);
                if (drop.label.material && drop.label.material.map) drop.label.material.map.dispose();
                if (drop.label.material) drop.label.material.dispose();
            }
            scene.remove(drop.mesh);
            disposeMesh(drop.mesh);
        }
        drops.length = 0;
        worldClearTimeSeconds = null;
        worldClearWarningActive = false;
    }

    /** Snap any drops in the column (vx, vz) that are *below* the given surface up so they sit on top.
     * Drops already above the surface (e.g. in a cave) are left where they are. */
    function snapDropsInColumn(vx, vz, surfaceTopY) {
        const topY = surfaceTopY + 1;
        const dropHalf = 0.55 / 2;
        const minBaseY = topY + dropHalf + 0.02;
        for (const drop of drops) {
            const mx = drop.mesh.position.x;
            const mz = drop.mesh.position.z;
            if (Math.floor(mx) !== vx || Math.floor(mz) !== vz) continue;
            if (drop.baseY < minBaseY) {
                drop.baseY = minBaseY;
                drop.mesh.position.y = minBaseY;
            }
        }
    }

    function setDropModels(models) {
        if (models && typeof models === 'object') {
            if (models.food != null) foodModel = models.food;
            if (models.stick != null) stickModel = models.stick;
            if (models.bone != null) boneModel = models.bone;
        }
    }

    return {
        spawnDrop,
        update,
        getCount,
        clearAll,
        snapDropsInColumn,
        setDropModels,
    };
}

