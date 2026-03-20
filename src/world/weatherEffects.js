import * as THREE from 'three';

function fillBoltPositions(out, segments, topY, bottomY, minRadiusXZ, maxRadiusXZ, jitter) {
    out.length = 0;
    const seg = Math.max(1, Math.floor(Number(segments) || 1));
    const top = Number.isFinite(topY) ? topY : 80;
    const bottom = Number.isFinite(bottomY) ? bottomY : 12;
    const minR = Number.isFinite(minRadiusXZ) ? minRadiusXZ : 120;
    const maxR = Number.isFinite(maxRadiusXZ) ? maxRadiusXZ : 280;
    const loR = Math.min(minR, maxR);
    const hiR = Math.max(minR, maxR);
    const jit = Number.isFinite(jitter) ? jitter : 5.5;

    const angle = Math.random() * Math.PI * 2;
    const radius = loR + Math.random() * Math.max(0, hiR - loR);
    const ox = Math.cos(angle) * radius;
    const oz = Math.sin(angle) * radius;

    // Slightly move the lower end so it looks like a bolt bends.
    const bend = radius * 0.22 + jit * 0.35;
    const bx = ox + (Math.random() - 0.5) * bend;
    const bz = oz + (Math.random() - 0.5) * bend;
    for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const falloff = 1 - t * 0.85;
        const x = THREE.MathUtils.lerp(ox, bx, t) + (Math.random() - 0.5) * jit * falloff;
        const y = THREE.MathUtils.lerp(top, bottom, t);
        const z = THREE.MathUtils.lerp(oz, bz, t) + (Math.random() - 0.5) * jit * falloff;
        out.push(x, y, z);
    }
}

function fillForkPositions(out, baseFlat, fromVertexIndex, segments, jitter) {
    out.length = 0;
    const i = fromVertexIndex * 3;
    const sx = baseFlat[i];
    const sy = baseFlat[i + 1];
    const sz = baseFlat[i + 2];
    let x = sx;
    let y = sy;
    let z = sz;
    out.push(x, y, z);
    const dirX = (Math.random() - 0.5) * 2.2;
    const dirZ = (Math.random() - 0.5) * 2.2;
    for (let k = 1; k <= segments; k++) {
        const t = k / segments;
        x += dirX * (2.5 + t * 4) + (Math.random() - 0.5) * jitter;
        y -= 3.5 + Math.random() * 4;
        z += dirZ * (2.5 + t * 4) + (Math.random() - 0.5) * jitter;
        out.push(x, y, z);
    }
}

function applyLinePositions(line, flat) {
    const n = flat.length / 3;
    const arr = new Float32Array(flat);
    let geo = line.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr || posAttr.count !== n) {
        geo.dispose();
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        line.geometry = geo;
    } else {
        posAttr.array.set(arr);
        posAttr.needsUpdate = true;
    }
}

/**
 * Local particle weather (rain / snow) + fog + storm lightning.
 * Group follows camera XZ so precipitation stays around the view.
 * @param {function} [restoreDistanceFog] - When mode is clear, called after removing weather fog so chunk-edge distance fog can return.
 */
export function createWeatherEffects(scene, getCameraWorldPosition, restoreDistanceFog) {
    let mode = 'clear';
    if (typeof window !== 'undefined') {
        window._weatherState = mode;
    }

    const group = new THREE.Group();
    group.name = 'WeatherEffects';
    scene.add(group);

    const _cam = new THREE.Vector3();
    let autoContext = null;
    let weatherDecisionCooldown = 0;
    let manualOverrideUntilMs = 0;

    function makePoints(count, color, pointSize) {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        const speeds = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 90;
            positions[i * 3 + 1] = Math.random() * 55 + 8;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 90;
            speeds[i] = 0.75 + Math.random() * 0.5;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.userData.speeds = speeds;
        geo.userData.count = count;
        const mat = new THREE.PointsMaterial({
            color,
            size: pointSize,
            transparent: true,
            opacity: 0.48,
            depthWrite: false,
            sizeAttenuation: true,
            blending: THREE.AdditiveBlending,
        });
        const pts = new THREE.Points(geo, mat);
        pts.visible = false;
        pts.frustumCulled = false;
        return pts;
    }

    const rainLight = makePoints(3500, 0xa8c8ff, 0.07);
    const rainHeavy = makePoints(9000, 0x8ab0d8, 0.085);
    const snowFlakes = makePoints(4500, 0xffffff, 0.11);

    group.add(rainLight, rainHeavy, snowFlakes);

    const lightningLight = new THREE.PointLight(0xddeeff, 0, 0);
    lightningLight.position.set(0, 45, 0);
    group.add(lightningLight);

    // Sky flash (subtle full-view pulse) + jagged bolt polylines during storm strikes
    const flashDomeGeo = new THREE.SphereGeometry(420, 20, 14);
    const flashDomeMat = new THREE.MeshBasicMaterial({
        color: 0xc5dcff,
        transparent: true,
        opacity: 0,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
    });
    const flashDome = new THREE.Mesh(flashDomeGeo, flashDomeMat);
    flashDome.position.set(0, 28, 0);
    flashDome.renderOrder = 5;
    flashDome.visible = false;
    group.add(flashDome);

    const boltGeo = new THREE.BufferGeometry();
    const boltMainMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    const boltGlowMat = new THREE.LineBasicMaterial({
        color: 0x7ab8ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    const boltMain = new THREE.Line(boltGeo, boltMainMat);
    const boltGlow = new THREE.Line(boltGeo, boltGlowMat);
    boltMain.frustumCulled = false;
    boltGlow.frustumCulled = false;
    boltMain.renderOrder = 12;
    boltGlow.renderOrder = 11;
    boltMain.visible = false;
    boltGlow.visible = false;
    group.add(boltGlow, boltMain);

    const forkGeo = new THREE.BufferGeometry();
    const forkMat = new THREE.LineBasicMaterial({
        color: 0xd8ecff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    const boltFork = new THREE.Line(forkGeo, forkMat);
    boltFork.frustumCulled = false;
    boltFork.renderOrder = 10;
    boltFork.visible = false;
    group.add(boltFork);

    const _mainBoltFlat = [];
    const _forkBoltFlat = [];
    let lightningHasFork = false;

    let lightningCooldown = 0;
    let lightningFlashLeft = 0;
    let lightningFlashT = 0.13;
    let lightningPeak = 0;
    const FLASH_DURATION = 0.13;

    function hideStormBoltVisuals() {
        flashDome.visible = false;
        boltMain.visible = false;
        boltGlow.visible = false;
        boltFork.visible = false;
        flashDomeMat.opacity = 0;
        boltMainMat.opacity = 0;
        boltGlowMat.opacity = 0;
        forkMat.opacity = 0;
    }

    const FOG = {
        lightrain: () => new THREE.FogExp2(0x8a9cb0, 0.019),
        rain: () => new THREE.FogExp2(0x7a8fa0, 0.026),
        heavyrain: () => new THREE.FogExp2(0x5c6a7a, 0.038),
        storm: () => new THREE.FogExp2(0x3a4250, 0.055),
        snow: () => new THREE.FogExp2(0xd0dce8, 0.024),
    };

    function applyFog(fogKey) {
        const fn = FOG[fogKey];
        scene.fog = fn ? fn() : null;
    }

    function setMode(next) {
        let m = String(next || 'clear').toLowerCase();
        if (m === 'cold') m = 'snow';
        const allowed = ['clear', 'lightrain', 'rain', 'heavyrain', 'storm', 'snow'];
        mode = allowed.includes(m) ? m : 'clear';

        rainLight.visible = mode === 'lightrain' || mode === 'rain';
        rainHeavy.visible = mode === 'heavyrain' || mode === 'storm';
        snowFlakes.visible = mode === 'snow';

        lightningLight.intensity = 0;
        lightningFlashLeft = 0;
        lightningFlashT = FLASH_DURATION;
        hideStormBoltVisuals();

        if (mode === 'lightrain') applyFog('lightrain');
        else if (mode === 'rain') applyFog('rain');
        else if (mode === 'heavyrain') applyFog('heavyrain');
        else if (mode === 'storm') applyFog('storm');
        else if (mode === 'snow') applyFog('snow');
        else {
            applyFog(null);
            if (typeof restoreDistanceFog === 'function') restoreDistanceFog();
        }

        if (mode === 'storm') {
            lightningCooldown = 0.4 + Math.random() * 1.2;
        }

        if (typeof window !== 'undefined') {
            window._weatherState = mode;
        }
    }

    function setManualMode(next, holdMs = 10 * 60 * 1000) {
        manualOverrideUntilMs = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) + Math.max(0, holdMs);
        setMode(next);
    }

    function setAutoContext(ctx) {
        autoContext = ctx || null;
    }

    function chooseAutoMode(ctx) {
        if (!ctx) return 'clear';
        const season = String(ctx.seasonName || '').toLowerCase();
        const biome = String(ctx.biome || '').toLowerCase();
        const worldTempC = Number(ctx.worldTempC ?? 10);
        const hour = Number(ctx.hour ?? 12);
        const isNight = hour < 6 || hour >= 19;

        let rain = 0.14;
        let heavy = 0.05;
        let storm = 0.025;
        let snow = 0;

        if (season === 'winter') {
            rain = 0.08;
            heavy = 0.03;
            storm = 0.012;
            snow = 0.22;
        } else if (season === 'summer') {
            rain = 0.11;
            heavy = 0.08;
            storm = 0.07;
        } else if (season === 'autumn') {
            rain = 0.18;
            heavy = 0.11;
            storm = 0.08;
            snow = 0.03;
        } else {
            rain = 0.15;
            heavy = 0.07;
            storm = 0.04;
            snow = 0.04;
        }

        if (biome === 'swamp' || biome === 'ocean') {
            rain += 0.06; heavy += 0.03; storm += 0.02;
        } else if (biome === 'mountains') {
            heavy += 0.02;
            if (worldTempC <= 2) snow += 0.16;
        } else if (biome === 'plains') {
            rain += 0.02;
        }

        if (worldTempC <= 0) {
            snow += 0.25;
            rain *= 0.45;
            heavy *= 0.45;
            storm *= 0.5;
        } else if (worldTempC <= 4) {
            snow += 0.12;
            rain *= 0.7;
            heavy *= 0.7;
        } else if (worldTempC >= 28) {
            storm += 0.025; // convection storms in hot conditions
        }

        if (isNight) {
            storm *= 0.8;
            heavy *= 0.9;
        }

        rain = Math.max(0, rain);
        heavy = Math.max(0, heavy);
        storm = Math.max(0, storm);
        snow = Math.max(0, snow);

        const totalPrecip = rain + heavy + storm + snow;
        const clear = Math.max(0.12, 1 - totalPrecip);
        const total = clear + rain + heavy + storm + snow;
        const r = Math.random() * total;
        if (r < clear) return 'clear';
        if (r < clear + rain * 0.42) return 'lightrain';
        if (r < clear + rain) return 'rain';
        if (r < clear + rain + heavy) return 'heavyrain';
        if (r < clear + rain + heavy + storm) return 'storm';
        return 'snow';
    }

    function animatePoints(pts, fallSpeed, driftX, driftZ, delta) {
        if (!pts.visible) return;
        const geo = pts.geometry;
        const pos = geo.attributes.position.array;
        const speeds = geo.userData.speeds;
        const n = geo.userData.count;
        const dt = delta;
        for (let i = 0; i < n; i++) {
            const iy = i * 3 + 1;
            pos[iy] -= fallSpeed * speeds[i] * dt * 18;
            pos[i * 3] += driftX * dt * speeds[i];
            pos[i * 3 + 2] += driftZ * dt * speeds[i];
            if (pos[iy] < 2) {
                pos[iy] = 50 + Math.random() * 20;
                pos[i * 3] = (Math.random() - 0.5) * 90;
                pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
            }
        }
        geo.attributes.position.needsUpdate = true;
    }

    function update(delta) {
        getCameraWorldPosition(_cam);
        group.position.set(_cam.x, 0, _cam.z);

        const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const manualActive = nowMs < manualOverrideUntilMs;
        if (!manualActive && autoContext) {
            weatherDecisionCooldown -= delta;
            if (weatherDecisionCooldown <= 0) {
                const next = chooseAutoMode(autoContext);
                if (next !== mode) setMode(next);
                // Avoid rapid weather flips: hold 45-120s between decisions.
                weatherDecisionCooldown = 45 + Math.random() * 75;
            }
        }

        if (mode === 'lightrain' || mode === 'rain') {
            animatePoints(rainLight, mode === 'lightrain' ? 0.85 : 1.05, 1.6, 0.9, delta);
        }
        if (mode === 'heavyrain' || mode === 'storm') {
            animatePoints(rainHeavy, 1.35, 4.5, 2.8, delta);
        }
        if (mode === 'snow') {
            const t = performance.now() * 0.0007;
            animatePoints(snowFlakes, 0.32, 1.1 * Math.sin(t), 0.75 * Math.cos(t * 0.85), delta);
        }

        if (mode === 'storm') {
            lightningCooldown -= delta;
            if (lightningCooldown <= 0) {
                lightningCooldown = 1.0 + Math.random() * 4.0;
                // Distance-located bolts: keep intensity slightly lower so it doesn't feel
                // too "in your face" when the flash happens.
                lightningPeak = 190 + Math.random() * 140;
                lightningFlashT = FLASH_DURATION * (0.72 + Math.random() * 0.48);
                lightningFlashLeft = lightningFlashT;

                fillBoltPositions(
                    _mainBoltFlat,
                    13 + Math.floor(Math.random() * 5),
                    82 + Math.random() * 8,
                    10 + Math.random() * 8,
                    120,
                    280,
                    5.5
                );
                applyLinePositions(boltMain, _mainBoltFlat);
                applyLinePositions(boltGlow, _mainBoltFlat);

                lightningHasFork = Math.random() > 0.34;
                if (lightningHasFork) {
                    const nVert = Math.floor(_mainBoltFlat.length / 3);
                    const vi = THREE.MathUtils.clamp(3 + Math.floor(Math.random() * 6), 2, Math.max(2, nVert - 3));
                    fillForkPositions(_forkBoltFlat, _mainBoltFlat, vi, 5 + Math.floor(Math.random() * 4), 4.5);
                    applyLinePositions(boltFork, _forkBoltFlat);
                    boltFork.visible = true;
                } else {
                    boltFork.visible = false;
                }

                const nV = Math.floor(_mainBoltFlat.length / 3);
                const mi = THREE.MathUtils.clamp(Math.floor(nV * 0.38), 0, Math.max(0, nV - 1));
                lightningLight.position.set(
                    _mainBoltFlat[mi * 3],
                    _mainBoltFlat[mi * 3 + 1],
                    _mainBoltFlat[mi * 3 + 2],
                );
                lightningLight.distance = 175;

                flashDome.visible = true;
                boltMain.visible = true;
                boltGlow.visible = true;
            }
        }

        if (lightningFlashLeft > 0) {
            lightningFlashLeft -= delta;
            const u = Math.max(0, lightningFlashLeft / Math.max(1e-4, lightningFlashT));
            const pulse = u * u;
            lightningLight.intensity = lightningPeak * pulse;
            const boltVis = Math.min(1, pulse * 4.8) * Math.min(1, u * 2.9);
            boltMainMat.opacity = boltVis * 0.95;
            boltGlowMat.opacity = boltVis * 0.44;
            forkMat.opacity = lightningHasFork && boltFork.visible ? boltVis * 0.68 : 0;
            flashDomeMat.opacity = boltVis * 0.11;
            if (lightningFlashLeft <= 0) {
                lightningLight.intensity = 0;
                hideStormBoltVisuals();
            }
        } else if (mode !== 'storm') {
            lightningLight.intensity = 0;
            hideStormBoltVisuals();
        }
    }

    function dispose() {
        scene.remove(group);
        rainLight.geometry.dispose();
        rainHeavy.geometry.dispose();
        snowFlakes.geometry.dispose();
        rainLight.material.dispose();
        rainHeavy.material.dispose();
        snowFlakes.material.dispose();
        flashDomeGeo.dispose();
        flashDomeMat.dispose();
        boltGeo.dispose();
        forkGeo.dispose();
        boltMainMat.dispose();
        boltGlowMat.dispose();
        forkMat.dispose();
    }

    return {
        getMode: () => mode,
        setMode,
        setManualMode,
        setAutoContext,
        update,
        dispose,
    };
}
