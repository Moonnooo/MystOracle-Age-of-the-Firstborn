// Tree system: stumps, staged voxel growth (sapling mesh → trunk → leaves).
// World trees from treeGenerator can register as growing; instant fallback if treeSystem missing.

import * as THREE from 'three';
import { BLOCK_IDS } from './blocksRegistry.js';
import {
    applyTreeGrowthDelta,
    getMaxTreeGrowthStage,
    placeTreePrefab,
    TREE_GROWTH_DELTAS,
} from './treeGenerator.js';

const TREE_CHOPS_TOTAL = 3;
const WOOD_PER_CHOP_MIN = 1;
const WOOD_PER_CHOP_MAX = 2;

// Time the sapling mesh stays visible before the first log appears
const SAPLING_MESH_SECONDS = 14;
// Time the stump sits before regrowth begins (first log)
const STUMP_REGROW_SECONDS = 45;
// Delay between each voxel growth step (trunk + leaf waves)
const GROWTH_STEP_MIN = 5.5;
const GROWTH_STEP_MAX = 9.5;

function randomGrowthGap() {
    return GROWTH_STEP_MIN + Math.random() * (GROWTH_STEP_MAX - GROWTH_STEP_MIN);
}

/** ~12% of trees stop one step early (no corner leaves) for slight size variety */
function rollMaxGrowthStage() {
    const full = getMaxTreeGrowthStage();
    return Math.random() < 0.12 ? full - 1 : full;
}

export function createTreeSystem(scene, terrain, treeModelFromLoader = null, stumpModelFromLoader = null) {
    const trees = [];
    const treesByChunk = new Map();
    const stumps = [];
    /**
     * Growing oak at trunk base (x, baseY, z) — bottom log position.
     * nextStageToApply: 0 = only sapling mesh; 1..N = next TREE_GROWTH_DELTAS index to apply.
     */
    const growingTrees = [];
    const initializedChunks = new Set();
    const chunkSize = terrain.chunkSize || 16;

    let treeModel = treeModelFromLoader;
    let stumpModel = stumpModelFromLoader;

    function placeTree(worldX, worldY, worldZ) {
        return null;
    }

    function removeTree(mesh) {
        if (!mesh || !mesh.userData.isTree) return;
        scene.remove(mesh);
        const idx = trees.indexOf(mesh);
        if (idx !== -1) trees.splice(idx, 1);
        const cx = Math.floor(mesh.userData.treeX / chunkSize);
        const cz = Math.floor(mesh.userData.treeZ / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkTrees = treesByChunk.get(chunkKey);
        if (chunkTrees) {
            const i = chunkTrees.indexOf(mesh);
            if (i !== -1) chunkTrees.splice(i, 1);
            if (chunkTrees.length === 0) treesByChunk.delete(chunkKey);
        }
    }

    function createStumpMesh(worldX, worldY, worldZ) {
        let stumpMesh;
        if (stumpModel && stumpModel.isObject3D) {
            stumpMesh = stumpModel.clone(true);
            stumpMesh.visible = true;
            stumpMesh.position.set(0, 0, 0);
            stumpMesh.rotation.set(0, 0, 0);
            stumpMesh.scale.set(1, 1, 1);
            stumpMesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(stumpMesh);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const maxXZ = Math.max(size.x, size.z);
            if (maxXZ > 0.01) {
                const targetFootprint = 0.9;
                const s = targetFootprint / maxXZ;
                stumpMesh.scale.setScalar(s);
            }
            stumpMesh.updateMatrixWorld(true);
            const scaledBbox = new THREE.Box3().setFromObject(stumpMesh);
            const center = new THREE.Vector3();
            scaledBbox.getCenter(center);
            const modelBottom = scaledBbox.min.y;
            stumpMesh.position.set(worldX + 0.5 - center.x, worldY - modelBottom, worldZ + 0.5 - center.z);
        } else {
            const radiusTop = 0.35;
            const radiusBottom = 0.4;
            const height = 0.5;
            const radialSegments = 8;
            const geom = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments);
            const mat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
            stumpMesh = new THREE.Mesh(geom, mat);
            stumpMesh.position.set(worldX + 0.5, worldY + height * 0.5, worldZ + 0.5);
        }
        stumpMesh.castShadow = true;
        stumpMesh.receiveShadow = true;
        stumpMesh.userData.isStump = true;
        stumpMesh.userData.stumpX = worldX;
        stumpMesh.userData.stumpY = worldY;
        stumpMesh.userData.stumpZ = worldZ;
        stumpMesh.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        stumpMesh.updateMatrixWorld(true);
        stumpMesh.userData.collisionBox = new THREE.Box3().setFromObject(stumpMesh);
        scene.add(stumpMesh);
        return stumpMesh;
    }

    function placeStump(worldX, worldY, worldZ) {
        const stumpMesh = createStumpMesh(worldX, worldY, worldZ);
        const now = performance.now() / 1000;
        stumps.push({
            mesh: stumpMesh,
            x: worldX,
            y: worldY,
            z: worldZ,
            respawnAt: now + STUMP_REGROW_SECONDS,
            dugUp: false,
        });
        return stumpMesh;
    }

    function chopTree(mesh) {
        if (!mesh || !mesh.userData.isTree) return null;
        const chopsLeft = mesh.userData.treeChopsLeft ?? TREE_CHOPS_TOTAL;
        if (chopsLeft <= 0) return null;
        const wood = WOOD_PER_CHOP_MIN + Math.floor(Math.random() * (WOOD_PER_CHOP_MAX - WOOD_PER_CHOP_MIN + 1));
        mesh.userData.treeChopsLeft = chopsLeft - 1;
        if (mesh.userData.treeChopsLeft <= 0) {
            const x = mesh.userData.treeX;
            const y = mesh.userData.treeY;
            const z = mesh.userData.treeZ;
            removeTree(mesh);
            placeStump(x, y, z);
        }
        const sticks = 1 + Math.floor(Math.random() * 2);
        const saplingsDrop = mesh.userData.treeChopsLeft <= 0 && Math.random() < 0.5 ? 1 : 0;
        return { wood, sticks, saplings: saplingsDrop };
    }

    function breakLeaves(mesh) {
        if (!mesh || !mesh.userData.isTree) return null;
        const leaves = 1 + Math.floor(Math.random() * 2);
        const saplingsDrop = Math.random() < 0.3 ? 1 : 0;
        return { leaves, saplings: saplingsDrop };
    }

    function createSaplingMesh() {
        const stickGeom = new THREE.CylinderGeometry(0.04, 0.05, 0.4, 6);
        const stickMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
        const stick = new THREE.Mesh(stickGeom, stickMat);
        const leafGeom = new THREE.SphereGeometry(0.15, 6, 4);
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x228b22 });
        const leaf = new THREE.Mesh(leafGeom, leafMat);
        leaf.position.y = 0.25;
        const group = new THREE.Group();
        group.add(stick);
        group.add(leaf);
        group.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        return group;
    }

    function removeGrowingMesh(entry) {
        if (entry.mesh && entry.mesh.parent === scene) {
            scene.remove(entry.mesh);
        }
        entry.mesh = null;
    }

    function attachSaplingMesh(entry) {
        const mesh = createSaplingMesh();
        mesh.userData.isSapling = true;
        mesh.userData.saplingX = entry.x;
        mesh.userData.saplingY = entry.baseY - 1;
        mesh.userData.saplingZ = entry.z;
        mesh.position.set(entry.x + 0.5, entry.baseY, entry.z + 0.5);
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        scene.add(mesh);
        entry.mesh = mesh;
    }

    /**
     * Wild tree: sapling mesh, then same staged growth as planted saplings.
     * trunk base Y = first log world Y (usually surfaceY + 1).
     */
    function registerWildGrowingTree(trunkBaseX, trunkBaseY, trunkBaseZ) {
        const now = performance.now() / 1000;
        const maxStageIndex = rollMaxGrowthStage();
        const entry = {
            mesh: null,
            x: trunkBaseX,
            baseY: trunkBaseY,
            z: trunkBaseZ,
            nextStageToApply: 0,
            maxStageIndex,
            nextStageAt: now + SAPLING_MESH_SECONDS * (0.75 + Math.random() * 0.5),
            kind: 'wild',
        };
        attachSaplingMesh(entry);
        growingTrees.push(entry);
    }

    /** Plant sapling on top of solid block at (blockX, blockY, blockZ); trunk starts at blockY+1. */
    function placeSapling(blockX, blockY, blockZ) {
        const now = performance.now() / 1000;
        const maxStageIndex = rollMaxGrowthStage();
        const entry = {
            mesh: null,
            x: blockX,
            baseY: blockY + 1,
            z: blockZ,
            nextStageToApply: 0,
            maxStageIndex,
            nextStageAt: now + SAPLING_MESH_SECONDS,
            kind: 'planted',
        };
        attachSaplingMesh(entry);
        growingTrees.push(entry);
        return true;
    }

    function isHitInLeaves(mesh, worldY) {
        if (!mesh || !mesh.userData.isTree) return false;
        const leavesMinY = mesh.userData.leavesMinY;
        return leavesMinY != null && worldY >= leavesMinY;
    }

    function logDeltaRequiresClearTrunkSlot(stageIndex) {
        const d = TREE_GROWTH_DELTAS[stageIndex];
        return d && d.length === 1 && d[0].type === BLOCK_IDS.LOG;
    }

    function advanceGrowingTree(entry, now) {
        if (entry.nextStageToApply === 0) {
            removeGrowingMesh(entry);
            entry.nextStageToApply = 1;
        }

        const stage = entry.nextStageToApply;
        if (logDeltaRequiresClearTrunkSlot(stage)) {
            const wx = entry.x + TREE_GROWTH_DELTAS[stage][0].dx;
            const wy = entry.baseY + TREE_GROWTH_DELTAS[stage][0].dy;
            const wz = entry.z + TREE_GROWTH_DELTAS[stage][0].dz;
            if (terrain.getVoxelAt(wx, wy, wz) !== BLOCK_IDS.AIR) {
                return 'abort';
            }
        }

        applyTreeGrowthDelta(terrain, entry.x, entry.baseY, entry.z, stage);

        if (stage >= entry.maxStageIndex) {
            return 'done';
        }

        entry.nextStageToApply = stage + 1;
        entry.nextStageAt = now + randomGrowthGap();
        return 'continue';
    }

    function update(delta) {
        const now = performance.now() / 1000;

        for (let i = stumps.length - 1; i >= 0; i--) {
            const s = stumps[i];
            if (s.dugUp) {
                stumps.splice(i, 1);
                continue;
            }
            if (now >= s.respawnAt) {
                if (s.mesh && s.mesh.parent === scene) {
                    scene.remove(s.mesh);
                }
                stumps.splice(i, 1);
                const maxStageIndex = rollMaxGrowthStage();
                growingTrees.push({
                    mesh: null,
                    x: s.x,
                    baseY: s.y + 1,
                    z: s.z,
                    nextStageToApply: 1,
                    maxStageIndex,
                    nextStageAt: now,
                    kind: 'stump',
                });
            }
        }

        for (let i = growingTrees.length - 1; i >= 0; i--) {
            const g = growingTrees[i];
            if (now < g.nextStageAt) continue;

            const result = advanceGrowingTree(g, now);
            if (result === 'abort') {
                removeGrowingMesh(g);
                growingTrees.splice(i, 1);
                continue;
            }
            if (result === 'done') {
                removeGrowingMesh(g);
                growingTrees.splice(i, 1);
                continue;
            }
        }
    }

    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        if (!initializedChunks.has(chunkKey)) {
            initializedChunks.add(chunkKey);
        }

        for (const s of stumps) {
            const sxChunk = Math.floor(s.x / chunkSize);
            const szChunk = Math.floor(s.z / chunkSize);
            if (sxChunk === cx && szChunk === cz) {
                if (!s.mesh || !s.mesh.parent) {
                    s.mesh = createStumpMesh(s.x, s.y, s.z);
                }
            }
        }

        for (const g of growingTrees) {
            if (g.nextStageToApply !== 0 || g.kind === 'stump') continue;
            const sxChunk = Math.floor(g.x / chunkSize);
            const szChunk = Math.floor(g.z / chunkSize);
            if (sxChunk === cx && szChunk === cz) {
                if (!g.mesh || !g.mesh.parent) {
                    attachSaplingMesh(g);
                }
            }
        }
    }

    function hasTreesInChunk(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        return initializedChunks.has(chunkKey);
    }

    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkTrees = treesByChunk.get(chunkKey) || [];
        for (const mesh of chunkTrees) {
            scene.remove(mesh);
            const idx = trees.indexOf(mesh);
            if (idx !== -1) trees.splice(idx, 1);
        }
        treesByChunk.delete(chunkKey);

        for (const s of stumps) {
            const sxChunk = Math.floor(s.x / chunkSize);
            const szChunk = Math.floor(s.z / chunkSize);
            if (sxChunk === cx && szChunk === cz) {
                if (s.mesh && s.mesh.parent === scene) {
                    scene.remove(s.mesh);
                }
            }
        }

        for (const g of growingTrees) {
            const sxChunk = Math.floor(g.x / chunkSize);
            const szChunk = Math.floor(g.z / chunkSize);
            if (sxChunk === cx && szChunk === cz) {
                if (g.mesh && g.mesh.parent === scene) {
                    scene.remove(g.mesh);
                }
            }
        }
    }

    function getStateForSave() {
        const allData = {};
        const now = performance.now() / 1000;

        function ensureChunk(key) {
            if (!allData[key]) {
                allData[key] = { trees: [], stumps: [], growing: [] };
            }
            return allData[key];
        }

        for (const mesh of trees) {
            const x = mesh.userData.treeX;
            const y = mesh.userData.treeY;
            const z = mesh.userData.treeZ;
            if (x == null || y == null || z == null) continue;
            const cx = Math.floor(x / chunkSize);
            const cz = Math.floor(z / chunkSize);
            const key = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            const bucket = ensureChunk(key);
            bucket.trees.push({
                x,
                y,
                z,
                chopsLeft: mesh.userData.treeChopsLeft ?? TREE_CHOPS_TOTAL,
            });
        }

        for (const s of stumps) {
            const cx = Math.floor(s.x / chunkSize);
            const cz = Math.floor(s.z / chunkSize);
            const key = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            const bucket = ensureChunk(key);
            const remaining = Math.max(0, (s.respawnAt ?? now) - now);
            bucket.stumps.push({
                x: s.x,
                y: s.y,
                z: s.z,
                respawnRemaining: remaining,
                dugUp: !!s.dugUp,
            });
        }

        for (const g of growingTrees) {
            const cx = Math.floor(g.x / chunkSize);
            const cz = Math.floor(g.z / chunkSize);
            const key = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
            const bucket = ensureChunk(key);
            const remaining = Math.max(0, (g.nextStageAt ?? now) - now);
            bucket.growing.push({
                x: g.x,
                baseY: g.baseY,
                z: g.z,
                nextStageToApply: g.nextStageToApply,
                maxStageIndex: g.maxStageIndex,
                nextStageIn: remaining,
                kind: g.kind,
            });
        }

        return allData;
    }

    function restoreFromSave(allData) {
        for (const mesh of trees.slice()) {
            if (mesh && mesh.parent === scene) scene.remove(mesh);
        }
        trees.length = 0;
        treesByChunk.clear();

        for (const s of stumps) {
            if (s.mesh && s.mesh.parent === scene) scene.remove(s.mesh);
        }
        stumps.length = 0;

        for (const g of growingTrees) {
            if (g.mesh && g.mesh.parent === scene) scene.remove(g.mesh);
        }
        growingTrees.length = 0;

        if (!allData || typeof allData !== 'object') return;

        const now = performance.now() / 1000;
        const fullStage = getMaxTreeGrowthStage();

        for (const [chunkKey, chunkData] of Object.entries(allData)) {
            if (!chunkData || typeof chunkData !== 'object') continue;

            const stumpArr = Array.isArray(chunkData.stumps) ? chunkData.stumps : [];

            for (const data of stumpArr) {
                if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') continue;
                const mesh = createStumpMesh(data.x, data.y, data.z);
                const remaining = typeof data.respawnRemaining === 'number' ? Math.max(0, data.respawnRemaining) : STUMP_REGROW_SECONDS;
                stumps.push({
                    mesh,
                    x: data.x,
                    y: data.y,
                    z: data.z,
                    respawnAt: now + remaining,
                    dugUp: !!data.dugUp,
                });
            }

            const growArr = Array.isArray(chunkData.growing) ? chunkData.growing : [];
            const legacySaplings = Array.isArray(chunkData.saplings) ? chunkData.saplings : [];

            for (const data of growArr) {
                if (!data || typeof data.x !== 'number' || typeof data.baseY !== 'number' || typeof data.z !== 'number') continue;
                const entry = {
                    mesh: null,
                    x: data.x,
                    baseY: data.baseY,
                    z: data.z,
                    nextStageToApply: typeof data.nextStageToApply === 'number' ? data.nextStageToApply : 0,
                    maxStageIndex: typeof data.maxStageIndex === 'number' ? data.maxStageIndex : fullStage,
                    nextStageAt: now + (typeof data.nextStageIn === 'number' ? Math.max(0, data.nextStageIn) : SAPLING_MESH_SECONDS),
                    kind: data.kind === 'wild' || data.kind === 'stump' ? data.kind : 'planted',
                };
                entry.maxStageIndex = Math.min(entry.maxStageIndex, fullStage);
                if (entry.nextStageToApply === 0 && entry.kind !== 'stump') {
                    attachSaplingMesh(entry);
                }
                growingTrees.push(entry);
            }

            for (const data of legacySaplings) {
                if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') continue;
                const remaining = typeof data.respawnRemaining === 'number' ? Math.max(0, data.respawnRemaining) : 60;
                const entry = {
                    mesh: null,
                    x: data.x,
                    baseY: data.y + 1,
                    z: data.z,
                    nextStageToApply: 0,
                    maxStageIndex: fullStage,
                    nextStageAt: now + Math.min(SAPLING_MESH_SECONDS, remaining * 0.25),
                    kind: 'planted',
                };
                attachSaplingMesh(entry);
                growingTrees.push(entry);
            }
        }
    }

    function digUpStump(mesh) {
        if (!mesh || !mesh.userData.isStump) return null;
        const entry = stumps.find((s) => s.mesh === mesh);
        if (!entry) return null;
        if (entry.mesh && entry.mesh.parent === scene) scene.remove(entry.mesh);
        entry.dugUp = true;
        const idx = stumps.indexOf(entry);
        if (idx !== -1) stumps.splice(idx, 1);
        const logs = 1 + Math.floor(Math.random() * 2);
        const dirt = 1;
        return { logs, dirt };
    }

    function getCollisionMeshes() {
        const list = [...trees];
        for (const s of stumps) {
            if (s.mesh && s.mesh.parent === scene) list.push(s.mesh);
        }
        for (const g of growingTrees) {
            if (g.mesh && g.mesh.parent === scene) list.push(g.mesh);
        }
        return list;
    }

    return {
        trees,
        placeTree,
        removeTree,
        chopTree,
        breakLeaves,
        isHitInLeaves,
        placeSapling,
        registerWildGrowingTree,
        digUpStump,
        getCollisionMeshes,
        update,
        onChunkLoad,
        onChunkUnload,
        hasTreesInChunk,
        getStateForSave,
        restoreFromSave,
    };
}
