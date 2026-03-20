// shooting.js
import * as THREE from 'three';

export function setupShooting(camera, getCollidersFn, destroyWallFn, getGamePaused = () => false){
    const raycaster = new THREE.Raycaster();

    window.addEventListener('mousedown', e => {
        if(e.button !== 0) return; // left click only
        if (getGamePaused()) return; // Block shooting when paused

        // Start ray just in front of camera to avoid clipping inside terrain
        const origin = new THREE.Vector3();
        camera.getWorldPosition(origin);
        const dir = new THREE.Vector3(0,0,-1);
        dir.applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
        dir.normalize();
        origin.add(dir.clone().multiplyScalar(0.2)); // Move origin 0.2 units forward
        raycaster.set(origin, dir);

        const colliders = getCollidersFn();
        const intersects = raycaster.intersectObjects(colliders, true);
        
        if(intersects.length > 0){
            const hit = intersects[0];
            destroyWallFn(hit);
        } else {
            // No collider hit (e.g. shooting into the sky) – still invoke destroyWallFn
            // so the caller can spawn visible projectiles.
            destroyWallFn(null);
        }
    });
}
