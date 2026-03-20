// lighting.js
import * as THREE from 'three';

export function createLighting(scene) {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // Sun (directional light)
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.castShadow = true;
    // Lower resolution = faster shadows (512). Use 1024 or 2048 for sharper quality.
    sun.shadow.mapSize.set(512, 512);
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 300;
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    sun.shadow.bias = -0.0005;
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);

    // Moon (directional light, much dimmer)
    const moon = new THREE.DirectionalLight(0xccccff, 0.1);
    moon.castShadow = false;
    scene.add(moon);

    return { ambientLight, sun, moon };
}
