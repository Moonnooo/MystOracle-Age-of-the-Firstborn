// Bed system: place bed in world; when placed, player respawns here on death.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../assets/assetBase.js';

export function createBedSystem(scene, terrain, bedModelFromLoader = null) {
    const beds = [];
    const bedsByChunk = new Map();

    let bedModel = bedModelFromLoader;
    if (!bedModel) {
        const loader = new GLTFLoader();
        loader.load(ASSET_BASE + 'models/bed.glb', (gltf) => {
            bedModel = gltf.scene;
        });
    }

    // Target size in world units (1 unit = 1 block = 1 meter): width (X), height (Y), depth (Z)
    const BED_TARGET_WIDTH = 2;
    const BED_TARGET_HEIGHT = 1;
    const BED_TARGET_DEPTH = 1;

    function placeBed(x, y, z) {
        let mesh;
        if (bedModel && bedModel.isObject3D) {
            mesh = bedModel.clone(true);
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
        } else {
            const geom = new THREE.BoxGeometry(BED_TARGET_WIDTH, BED_TARGET_HEIGHT, BED_TARGET_DEPTH);
            const mat = new THREE.MeshStandardMaterial({ color: 0x8b4513 });
            mesh = new THREE.Mesh(geom, mat);
        }

        mesh.visible = true;
        mesh.userData.isBed = true;
        mesh.traverse((c) => {
            if (c.isMesh) {
                c.castShadow = true;
                c.receiveShadow = true;
                c.userData.isBed = true;
            }
        });

        mesh.position.set(0, 0, 0);
        mesh.updateMatrixWorld(true);
        const localBbox = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        localBbox.getSize(size);
        const modelBottom = localBbox.min.y;
        // Scale so the model fits target size (2m wide, 1m tall, 1m deep) regardless of export scale
        if (size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6) {
            mesh.scale.set(
                BED_TARGET_WIDTH / size.x,
                BED_TARGET_HEIGHT / size.y,
                BED_TARGET_DEPTH / size.z
            );
        }
        mesh.updateMatrixWorld(true);
        const bboxAfterScale = new THREE.Box3().setFromObject(mesh);
        const bottomAfter = bboxAfterScale.min.y;
        mesh.position.set(x + 0.5, y - bottomAfter, z + 0.5);

        scene.add(mesh);
        mesh.updateMatrixWorld(true);
        mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
        mesh.userData.bedX = x;
        mesh.userData.bedY = y;
        mesh.userData.bedZ = z;

        beds.push(mesh);
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkBeds = bedsByChunk.get(chunkKey) || [];
        chunkBeds.push(mesh);
        bedsByChunk.set(chunkKey, chunkBeds);

        saveBedData();
        return mesh;
    }

    function removeBed(mesh) {
        scene.remove(mesh);
        const idx = beds.indexOf(mesh);
        if (idx !== -1) beds.splice(idx, 1);
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(mesh.userData.bedX / chunkSize);
        const cz = Math.floor(mesh.userData.bedZ / chunkSize);
        const chunkKey = `${cx},${cz}`;
        const chunkBeds = bedsByChunk.get(chunkKey);
        if (chunkBeds) {
            const chunkIdx = chunkBeds.indexOf(mesh);
            if (chunkIdx !== -1) chunkBeds.splice(chunkIdx, 1);
            if (chunkBeds.length === 0) bedsByChunk.delete(chunkKey);
        }
        saveBedData();
    }

    function saveBedData() {
        const all = {};
        for (const [chunkKey, chunkBeds] of bedsByChunk.entries()) {
            const data = chunkBeds.map((m) => ({
                x: m.userData.bedX,
                y: m.userData.bedY,
                z: m.userData.bedZ,
            }));
            if (data.length > 0) all[chunkKey] = data;
        }
        try {
            localStorage.setItem('voxelBeds', JSON.stringify(all));
        } catch (e) {}
    }

    function loadBedData() {
        try {
            const saved = localStorage.getItem('voxelBeds');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return {};
    }

    function onChunkLoad(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const savedData = loadBedData();
        const chunkData = savedData[chunkKey] || [];

        for (const data of chunkData) {
            const existing = beds.find(
                (b) =>
                    b.userData.bedX === data.x &&
                    b.userData.bedY === data.y &&
                    b.userData.bedZ === data.z
            );
            if (existing) {
                if (!scene.children.includes(existing)) scene.add(existing);
                continue;
            }

            let mesh;
            if (bedModel && bedModel.isObject3D) {
                mesh = bedModel.clone(true);
                mesh.position.set(0, 0, 0);
                mesh.rotation.set(0, 0, 0);
                mesh.scale.set(1, 1, 1);
            } else {
                const geom = new THREE.BoxGeometry(1, 0.4, 0.6);
                const mat = new THREE.MeshStandardMaterial({ color: 0x8b4513 });
                mesh = new THREE.Mesh(geom, mat);
            }
            mesh.visible = true;
            mesh.userData.isBed = true;
            mesh.traverse((c) => {
                if (c.isMesh) {
                    c.castShadow = true;
                    c.receiveShadow = true;
                    c.userData.isBed = true;
                }
            });
            mesh.position.set(0, 0, 0);
            mesh.updateMatrixWorld(true);
            const localBbox = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            localBbox.getSize(size);
            const modelBottom = localBbox.min.y;
            if (size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6) {
                mesh.scale.set(
                    BED_TARGET_WIDTH / size.x,
                    BED_TARGET_HEIGHT / size.y,
                    BED_TARGET_DEPTH / size.z
                );
            }
            mesh.updateMatrixWorld(true);
            const bboxAfter = new THREE.Box3().setFromObject(mesh);
            mesh.position.set(data.x + 0.5, data.y - bboxAfter.min.y, data.z + 0.5);
            scene.add(mesh);
            mesh.updateMatrixWorld(true);
            mesh.userData.collisionBox = new THREE.Box3().setFromObject(mesh);
            mesh.userData.bedX = data.x;
            mesh.userData.bedY = data.y;
            mesh.userData.bedZ = data.z;
            beds.push(mesh);
            const chunkBeds = bedsByChunk.get(chunkKey) || [];
            chunkBeds.push(mesh);
            bedsByChunk.set(chunkKey, chunkBeds);
        }
    }

    function onChunkUnload(cx, cz) {
        const chunkKey = terrain.getChunkKey ? terrain.getChunkKey(cx, cz) : `${cx},${cz}`;
        const chunkBeds = bedsByChunk.get(chunkKey) || [];
        for (const mesh of chunkBeds) {
            if (mesh && scene.children.includes(mesh)) scene.remove(mesh);
        }
        saveBedData();
        bedsByChunk.delete(chunkKey);
    }

    return {
        placeBed,
        removeBed,
        beds,
        onChunkLoad,
        onChunkUnload,
    };
}
