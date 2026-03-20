// collision.js - Collision detection utilities for voxel terrain
import * as THREE from 'three';
import { isWater } from '../world/blocksRegistry.js';

/**
 * Check if a sphere (camera/object) collides with terrain voxels
 * Returns true if the position causes collision
 */
export function checkCollision(terrain, x, y, z, radius = 0.3, chestSystem = null, campfireSystem = null, furnaceSystem = null, loomSystem = null, bedSystem = null, mobSystem = null, treeSystem = null) {
    // Check all voxels within the radius around the position
    const minX = Math.floor(x - radius);
    const maxX = Math.floor(x + radius);
    const minY = Math.floor(y - radius);
    const maxY = Math.floor(y + radius);
    const minZ = Math.floor(z - radius);
    const maxZ = Math.floor(z + radius);

    for (let vx = minX; vx <= maxX; vx++) {
        for (let vy = minY; vy <= maxY; vy++) {
            for (let vz = minZ; vz <= maxZ; vz++) {
                const type = terrain.getVoxelAt(vx, vy, vz);
                // Water is non-solid; ignore it for collision checks.
                if (!type || isWater(type)) continue;
                // Check if the sphere actually intersects this voxel
                if (sphereVoxelIntersect(x, y, z, radius, vx, vy, vz)) {
                    return true;
                }
            }
        }
    }
    
    // Check collision with chests
    if (chestSystem && chestSystem.chests) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const chest of chestSystem.chests) {
            if (chest.userData.collisionBox) {
                // collisionBox is already stored in world space (setFromObject after updateMatrixWorld)
                const box = chest.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                const dist = playerPos.distanceTo(closestPoint);
                if (dist < radius) {
                    return true;
                }
            }
        }
    }
    
    // Check collision with campfires
    if (campfireSystem && campfireSystem.campfires) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const campfire of campfireSystem.campfires) {
            if (campfire.userData.collisionBox) {
                const box = campfire.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                const dist = playerPos.distanceTo(closestPoint);
                if (dist < radius) return true;
            }
        }
    }
    // Check collision with furnaces
    if (furnaceSystem && furnaceSystem.furnaces) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const furnace of furnaceSystem.furnaces) {
            if (furnace.userData.collisionBox) {
                const box = furnace.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                if (playerPos.distanceTo(closestPoint) < radius) return true;
            }
        }
    }
    // Check collision with looms
    if (loomSystem && loomSystem.looms) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const loom of loomSystem.looms) {
            if (loom.userData.collisionBox) {
                const box = loom.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                if (playerPos.distanceTo(closestPoint) < radius) return true;
            }
        }
    }

    // Check collision with beds
    if (bedSystem && bedSystem.beds) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const bed of bedSystem.beds) {
            if (bed.userData.collisionBox) {
                const box = bed.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                if (playerPos.distanceTo(closestPoint) < radius) return true;
            }
        }
    }
    
    // Check collision with mobs
    if (mobSystem && mobSystem.mobMeshes) {
        const playerPos = new THREE.Vector3(x, y, z);
        for (const mobMesh of mobSystem.mobMeshes) {
            const mobType = mobMesh.userData.mobType;
            if (mobType) {
                const mobRadius = 0.5;
                const dist = playerPos.distanceTo(mobMesh.position);
                if (dist < radius + mobRadius) return true;
            }
        }
    }

    // Check collision with trees, stumps, and saplings
    if (treeSystem) {
        const meshes = typeof treeSystem.getCollisionMeshes === 'function'
            ? treeSystem.getCollisionMeshes()
            : (treeSystem.trees || []);
        const playerPos = new THREE.Vector3(x, y, z);
        for (const mesh of meshes) {
            if (mesh.userData.collisionBox) {
                const box = mesh.userData.collisionBox;
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                if (playerPos.distanceTo(closestPoint) < radius) return true;
            } else {
                const box = new THREE.Box3().setFromObject(mesh);
                const closestPoint = box.clampPoint(playerPos, new THREE.Vector3());
                if (playerPos.distanceTo(closestPoint) < radius) return true;
            }
        }
    }
    
    return false;
}

/**
 * Check if a sphere intersects with a voxel (axis-aligned box)
 */
function sphereVoxelIntersect(sx, sy, sz, radius, vx, vy, vz) {
    // Voxel is centered at (vx+0.5, vy+0.5, vz+0.5) with size 1
    const vhalf = 0.5;
    const vxc = vx + vhalf;
    const vyc = vy + vhalf;
    const vzc = vz + vhalf;

    // Find closest point on voxel to sphere center
    const fx = Math.max(vx, Math.min(sx, vx + 1));
    const fy = Math.max(vy, Math.min(sy, vy + 1));
    const fz = Math.max(vz, Math.min(sz, vz + 1));

    // Distance between sphere center and closest point
    const dx = sx - fx;
    const dy = sy - fy;
    const dz = sz - fz;
    const distSq = dx * dx + dy * dy + dz * dz;

    return distSq < radius * radius;
}
