// player.js
import * as THREE from 'three';

export const playerHeight = 1.6;

export function createPlayer(scene) {
    const player = new THREE.Object3D();
    player.position.set(0, 0, 0);
    scene.add(player);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, playerHeight, 0);
    player.add(camera);

    camera.rotation.order = 'YXZ';
    player.rotation.order = 'YXZ';

    // Helper to get world position (for coordinates)
    function getWorldPosition() {
        const pos = new THREE.Vector3();
        player.getWorldPosition(pos);
        return pos;
    }

    return { player, camera, getWorldPosition };
}
