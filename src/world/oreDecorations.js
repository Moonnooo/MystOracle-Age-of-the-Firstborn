import * as THREE from 'three';
import { BLOCK_IDS, isWater } from './blocksRegistry.js';

// Visual-only ore decoration meshes (GLB) placed on top of ore voxels.
// Performance: uses a single `InstancedMesh` per chunk instead of cloning one
// object per ore voxel (massively reduces draw calls and GC pressure).
export function createOreDecorationsSystem(scene, terrain, oreModel = null) {
    const chunkSize = terrain.chunkSize || 16;
    const height = terrain.height || 64;
    const voxelData = terrain.getVoxelData();

    const oreBlockIds = new Set([BLOCK_IDS.COAL_ORE, BLOCK_IDS.IRON_ORE, BLOCK_IDS.GOLD_ORE]);

    if (typeof window !== 'undefined' && window.DEBUG_ORE_DECORATIONS) {
        if (!oreModel) console.warn('[OreDecorations] oreModel is null; no instanced decorations will be created.');
    }

    // chunkKey -> InstancedMesh
    const instancedByChunk = new Map();
    const initializedChunks = new Set();

    const MAX_DECORATIONS_PER_CHUNK = 48; // cap to protect FPS

    function getChunkKey(cx, cz) {
        return terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
    }

    function getVoxelIfLoaded(wx, wy, wz) {
        const x = Math.floor(wx);
        const y = Math.floor(wy);
        const z = Math.floor(wz);
        if (y < 0 || y >= height) return undefined;

        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = getChunkKey(cx, cz);
        const chunk = voxelData.get(chunkKey);
        if (!chunk) return undefined;

        const lx = ((x % chunkSize) + chunkSize) % chunkSize;
        const lz = ((z % chunkSize) + chunkSize) % chunkSize;
        return chunk[lx]?.[y]?.[lz] || 0;
    }

    function isExposedOre(wx, wy, wz) {
        const dirs = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
        ];

        for (const [dx, dy, dz] of dirs) {
            const nx = wx + dx;
            const ny = wy + dy;
            const nz = wz + dz;
            const neighbor = getVoxelIfLoaded(nx, ny, nz);
            // If neighbor chunk isn't loaded yet, we can't verify occupancy.
            // For visual correctness (and to avoid missing ore models exactly on
            // chunk edges), we treat "unknown" as air for exposure purposes.
            if (neighbor === undefined) return true;
            if (neighbor === 0 || isWater(neighbor)) return true;
        }
        return false;
    }

    // Prepare baked geometries/materials extracted from the ore model.
    // Some GLBs include multiple meshes; to render the whole model we build
    // one InstancedMesh per baked mesh.
    // Each baked geometry is transformed into world coords for the model at origin.
    let bakedMeshes = null; // Array<{ geometry, material }>
    let bboxMinX = 0;
    let bboxMinY = 0;
    let bboxMinZ = 0;
    let instanceScale = 1;

    function initBaseFromModel() {
        if (!oreModel || !oreModel.isObject3D) return false;

        const temp = oreModel.clone(true);
        temp.position.set(0, 0, 0);
        temp.rotation.set(0, 0, 0);
        temp.scale.set(1, 1, 1);
        temp.updateMatrixWorld(true);

        // Overall model bounds at origin.
        const modelBBox = new THREE.Box3().setFromObject(temp);
        const modelSize = new THREE.Vector3();
        modelBBox.getSize(modelSize);
        const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z, 0.0001);

        const target = 0.92; // how much of the voxel we want to occupy
        instanceScale = Math.min(1, target / maxDim);

        bboxMinX = modelBBox.min.x;
        bboxMinY = modelBBox.min.y;
        bboxMinZ = modelBBox.min.z;

        const meshes = [];
        temp.traverse((c) => {
            if (!c.isMesh || !c.geometry) return;
            if (!c.material) return;

            // Bake the mesh's world transform into geometry so a per-instance
            // matrix only needs to position the baked model.
            const geom = c.geometry.clone();
            geom.applyMatrix4(c.matrixWorld);
            meshes.push({ geometry: geom, material: c.material });
        });

        bakedMeshes = meshes;
        return bakedMeshes.length > 0;
    }

    const ok = initBaseFromModel();
    if (typeof window !== 'undefined' && window.DEBUG_ORE_DECORATIONS && oreModel && !ok) {
        console.warn('[OreDecorations] Failed to extract instancing geometry/material from ore model.');
    }
    if (typeof window !== 'undefined' && window.DEBUG_ORE_DECORATIONS && ok) {
        console.log(`[OreDecorations] bakedMeshes=${bakedMeshes.length} bboxMin=(${bboxMinX.toFixed(2)},${bboxMinY.toFixed(2)},${bboxMinZ.toFixed(2)}) instanceScale=${instanceScale.toFixed(3)}`);
    }

    function disposeInstancedMesh(mesh) {
        if (!mesh) return;
        scene.remove(mesh);
        // We share baseGeometry/material; do not dispose them here.
        if (mesh.instanceMatrix) mesh.instanceMatrix = null;
        if (mesh.geometry && mesh.geometry.dispose) {
            try { mesh.geometry.dispose(); } catch (_) {}
        }
    }

    function rebuildChunkDecorations(cx, cz) {
        if (!bakedMeshes || bakedMeshes.length === 0) return;

        const ck = getChunkKey(cx, cz);
        const voxels = voxelData.get(ck);
        if (!voxels) return;

        // Remove old instanced mesh.
        const old = instancedByChunk.get(ck);
        if (old) {
            for (const m of old) disposeInstancedMesh(m);
            instancedByChunk.delete(ck);
        }

        const exposedPositions = [];
        const wx0 = cx * chunkSize;
        const wz0 = cz * chunkSize;

        for (let lx = 0; lx < chunkSize; lx++) {
            for (let lz = 0; lz < chunkSize; lz++) {
                const wx = wx0 + lx;
                const wz = wz0 + lz;
                for (let y = 0; y < height; y++) {
                    const t = voxels[lx]?.[y]?.[lz] || 0;
                    if (!oreBlockIds.has(t)) continue;
                    if (!isExposedOre(wx, y, wz)) continue;
                    exposedPositions.push([wx, y, wz]);
                    if (exposedPositions.length >= MAX_DECORATIONS_PER_CHUNK) break;
                }
                if (exposedPositions.length >= MAX_DECORATIONS_PER_CHUNK) break;
            }
            if (exposedPositions.length >= MAX_DECORATIONS_PER_CHUNK) break;
        }

        if (exposedPositions.length === 0) return;

        if (typeof window !== 'undefined' && window.DEBUG_ORE_DECORATIONS) {
            console.log(`[OreDecorations] chunk ${cx},${cz} instances=${exposedPositions.length}`);
        }

        // Create one chunk instanced mesh per baked sub-mesh.
        const instancedMeshes = bakedMeshes.map(({ geometry, material }) => {
            const instanced = new THREE.InstancedMesh(geometry.clone(), material, exposedPositions.length);
            instanced.castShadow = true;
            instanced.receiveShadow = true;
            return instanced;
        });

        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3(instanceScale, instanceScale, instanceScale);

        // Translation places the mesh so the baked-model center sits on the voxel.
        for (let i = 0; i < exposedPositions.length; i++) {
            const [wx, wy, wz] = exposedPositions[i];

            // Align the baked-model bounding box to the voxel:
            // - bbox.min.x/z -> voxel min x/z
            // - bbox.min.y -> voxel top (wy+1), so it sits on top of the ore block.
            const tx = wx - bboxMinX * instanceScale;
            const ty = (wy + 1) - bboxMinY * instanceScale + 0.01;
            const tz = wz - bboxMinZ * instanceScale;

            m.compose(new THREE.Vector3(tx, ty, tz), q, s);
            for (const instanced of instancedMeshes) {
                instanced.setMatrixAt(i, m);
            }
        }
        for (const instanced of instancedMeshes) {
            instanced.instanceMatrix.needsUpdate = true;
            instanced.computeBoundingSphere();
            scene.add(instanced);
        }

        instancedByChunk.set(ck, instancedMeshes);
    }

    function onChunkLoad(cx, cz) {
        const ck = getChunkKey(cx, cz);
        if (!initializedChunks.has(ck)) {
            initializedChunks.add(ck);
        }
        rebuildChunkDecorations(cx, cz);
        // Rebuild neighbors too because exposure can change across chunk boundaries.
        rebuildChunkDecorations(cx + 1, cz);
        rebuildChunkDecorations(cx - 1, cz);
        rebuildChunkDecorations(cx, cz + 1);
        rebuildChunkDecorations(cx, cz - 1);
    }

    function onChunkUnload(cx, cz) {
        const ck = getChunkKey(cx, cz);
        const inst = instancedByChunk.get(ck);
        if (inst) {
            for (const m of inst) disposeInstancedMesh(m);
            instancedByChunk.delete(ck);
        }
    }

    // Called after a voxel is removed (mined). This may expose neighboring ores.
    // oreType is optional; if it's not one of our ores, we skip rebuild.
    function onVoxelRemoved(vx, vy, vz, oreType = null) {
        if (!oreType && oreType !== 0) {
            // unknown; rebuild anyway for safety but cap rebuild to just adjacent chunks.
        }

        if (oreType != null && !oreBlockIds.has(oreType)) return;

        const cx = Math.floor(vx / chunkSize);
        const cz = Math.floor(vz / chunkSize);

        // Rebuild current + 4-neighbors because exposure depends on adjacent air.
        rebuildChunkDecorations(cx, cz);
        rebuildChunkDecorations(cx + 1, cz);
        rebuildChunkDecorations(cx - 1, cz);
        rebuildChunkDecorations(cx, cz + 1);
        rebuildChunkDecorations(cx, cz - 1);
    }

    return {
        onChunkLoad,
        onChunkUnload,
        onVoxelRemoved,
        getDecorationsCount() {
            let total = 0;
            for (const mesh of instancedByChunk.values()) {
                for (const m of mesh) total += m.count;
            }
            return total;
        },
    };
}

