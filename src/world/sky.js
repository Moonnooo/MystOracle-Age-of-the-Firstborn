
import * as THREE from 'three';
import { createLighting } from '../core/lighting.js';

export function createSky(scene, camera, raycastBlockers, lighting) {
    const dayColor = new THREE.Color(0x87ceeb);
    // Slightly brighter, more bluish night for moonlight effect
    const nightColor = new THREE.Color(0x202438);

    // Use provided lighting or create new if not provided
    let ambientLight, sun, moon;
    if (lighting) {
        ambientLight = lighting.ambientLight;
        sun = lighting.sun;
        moon = lighting.moon;
    } else {
        const l = createLighting(scene);
        ambientLight = l.ambientLight;
        sun = l.sun;
        moon = l.moon;
    }

    // --- Sun & Moon meshes ---
    const sunMeshMat = new THREE.MeshBasicMaterial({ color: 0xffff66, fog: false });
    const sunMesh = new THREE.Mesh(
        new THREE.SphereGeometry(12, 32, 32), // slightly bigger
        sunMeshMat
    );
    scene.add(sunMesh);

    const moonMeshMat = new THREE.MeshBasicMaterial({ color: 0xddddff, fog: false });
    const moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(8, 32, 32), // smaller than sun
        moonMeshMat
    );
    scene.add(moonMesh);

    // --- Cube Skybox ---
    const skySize = 1000;
    const skyGeo = new THREE.BoxGeometry(skySize, skySize, skySize);
    const skyMat = new THREE.MeshBasicMaterial({
        color: dayColor,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
    });
    const skyBox = new THREE.Mesh(skyGeo, skyMat);
    skyBox.renderOrder = -1;
    scene.add(skyBox);

    // --- Time ---
    let time = 12; // start at noon
    let dayCount = 0; // how many full days have passed
    /** Multiplier on default day length (1 = normal). Dev console can set to 0 to freeze. */
    let timeScale = 1;
    const _camWorld = new THREE.Vector3();

    function smoothstep(v) {
        return v * v * (3 - 2 * v);
    }

    // configure sun shadow camera area for broader shadows
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;

    function update(delta) {
        time += delta * 0.03 * timeScale; // slightly slower day progression
        if (time > 24) {
            time -= 24;
            dayCount++;
        }

        const orbitRadius = 200;

        // Azimuth: horizontal rotation
        const azimuth = (time / 24) * Math.PI * 2;

        // Elevation: vertical arc
        const elevation = Math.sin((time / 24) * Math.PI) * Math.PI / 4 + Math.PI / 4;

        const x = Math.cos(elevation) * Math.sin(azimuth) * orbitRadius;
        const y = Math.sin(elevation) * orbitRadius;
        const z = Math.cos(elevation) * Math.cos(azimuth) * orbitRadius;

        sun.position.set(x, y, z);
        moon.position.set(-x, -y, -z);

        sunMesh.position.copy(sun.position);
        moonMesh.position.copy(moon.position);

        // --- Smoother day/night transition ---
        // Blend window: 4am-10am (dawn), 16pm-22pm (dusk)
        let t = 0;
        if (time < 6) {
            t = 0;
        } else if (time < 10) {
            t = (time - 6) / 4;
        } else if (time < 16) {
            t = 1;
        } else if (time < 22) {
            t = 1 - (time - 16) / 6;
        } else {
            t = 0;
        }
        t = THREE.MathUtils.clamp(t, 0, 1);
        t = smoothstep(t);

        // Sky color lerp
        skyMat.color.copy(nightColor).lerp(dayColor, t);

        // Sun color: warm at dawn/dusk, white at noon
        const dawnColor = new THREE.Color(0xffe0a0);
        const noonColor = new THREE.Color(0xffffff);
        const sunColor = dawnColor.clone().lerp(noonColor, t);
        sun.color.copy(sunColor);

        // Sun intensity and moon intensity
        // Keep some moonlight at night so it's not pitch black
        sun.intensity = THREE.MathUtils.lerp(0.05, 1.5, t);
        moon.intensity = THREE.MathUtils.lerp(0.6, 0.1, t);

        // Ambient light subtle change (brighter at night than before)
        ambientLight.intensity = THREE.MathUtils.lerp(0.25, 0.6, t);

        // Lock skybox to camera so it's always centered on the player (infinite sky).
        // Camera is a child of the player, so use world position, not camera.position.
        camera.getWorldPosition(_camWorld);
        skyBox.position.copy(_camWorld);

        // Shadows optimization: enable/disable shadow casting for nearby objects
        const shadowDistance = 40;
        if (Array.isArray(raycastBlockers)) {
            raycastBlockers.forEach(wall => {
                const dist = wall.position.distanceTo(_camWorld);
                wall.castShadow = dist < shadowDistance;
            });
        }
    }

    function getTime() {
        return time;
    }

    function getDayCount() {
        return dayCount;
    }

    function setTime(t) {
        time = Math.max(0, Math.min(24, Number(t)));
    }

    function setDayCount(n) {
        dayCount = Math.max(0, Math.floor(Number(n)));
    }

    function getTimeScale() {
        return timeScale;
    }

    function setTimeScale(s) {
        const v = Number(s);
        timeScale = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 1;
    }

    return {
        update, sun, moon, sunMesh, moonMesh, ambientLight,
        getTime, getDayCount, setTime, setDayCount, getTimeScale, setTimeScale,
    };
}
