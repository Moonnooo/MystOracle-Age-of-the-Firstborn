/**
 * Visible projectiles: bullets (straight, fast) and arrows (arc with gravity).
 * Used for player gun/bow and skeleton bow. Damage is applied when the projectile hits.
 */
import * as THREE from 'three';

const BULLET_SPEED = 80;
const BULLET_RADIUS = 0.04;
const BULLET_GRAVITY = -20;
const ARROW_SPEED = 32;
const ARROW_GRAVITY = -28;
const ARROW_RADIUS = 0.06;
const MAX_LIFETIME = 8;
const SEGMENT_RAYCAST_EPS = 0.001;
const HEADSHOT_THRESHOLD = 0.65; // top 35% of mob bounds counts as headshot

export function createProjectileSystem(scene, getColliders, onHitMob, onHitPlayer, getPlayerPosition = null, playerRadius = 0.4, arrowTextureUrl = null) {
    const projectiles = [];
    const raycaster = new THREE.Raycaster();
    const segStart = new THREE.Vector3();
    const segEnd = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();
    const mobBounds = new THREE.Box3();

    let arrowTexture = null;
    if (arrowTextureUrl) {
        const loader = new THREE.TextureLoader();
        loader.load(arrowTextureUrl, (tex) => {
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            arrowTexture = tex;
        });
    }

    function makeBulletMesh() {
        const geo = new THREE.SphereGeometry(BULLET_RADIUS * 2, 8, 6);
        const mat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = false;
        m.receiveShadow = false;
        return m;
    }

    function makeArrowMesh() {
        let m;
        if (arrowTexture) {
            const geo = new THREE.PlaneGeometry(0.5, 0.12);
            const mat = new THREE.MeshBasicMaterial({
                map: arrowTexture,
                transparent: true,
                side: THREE.DoubleSide,
            });
            m = new THREE.Mesh(geo, mat);
            m.rotation.x = -Math.PI / 2;
        } else {
            const geo = new THREE.CylinderGeometry(ARROW_RADIUS, ARROW_RADIUS * 0.8, 0.5, 8);
            const mat = new THREE.MeshBasicMaterial({ color: 0x8B4513 });
            m = new THREE.Mesh(geo, mat);
            m.rotation.x = Math.PI / 2;
        }
        m.castShadow = false;
        m.receiveShadow = false;
        return m;
    }

    function findMobRoot(obj) {
        let o = obj;
        while (o && !o.userData.mobType && o.parent) o = o.parent;
        return o && o.userData.mobType ? o : null;
    }

    function hitTestSegment(from, to, excludeMesh) {
        segStart.copy(from);
        segEnd.copy(to);
        const dir = segEnd.clone().sub(segStart);
        const len = dir.length();
        if (len < SEGMENT_RAYCAST_EPS) return null;
        dir.normalize();
        raycaster.set(segStart, dir);
        raycaster.far = len + 0.01;
        raycaster.near = 0;
        const colliders = getColliders();
        const list = excludeMesh ? colliders.filter(c => c !== excludeMesh) : colliders;
        const hits = raycaster.intersectObjects(list, true);
        if (hits.length === 0) return null;
        const hit = hits[0];
        if (hit.distance > len) return null;
        return hit;
    }

    function segmentIntersectsSphere(a, b, center, r) {
        const ab = b.clone().sub(a);
        const ac = center.clone().sub(a);
        const abLen = ab.length();
        if (abLen < 1e-6) return ac.length() <= r;
        const t = THREE.MathUtils.clamp(ac.dot(ab) / (abLen * abLen), 0, 1);
        const closest = a.clone().addScaledVector(ab, t);
        return closest.distanceTo(center) <= r;
    }

    function spawnBullet(origin, direction, damage, owner = 'player') {
        const dir = direction.clone().normalize();
        const mesh = makeBulletMesh();
        mesh.position.copy(origin);
        scene.add(mesh);
        projectiles.push({
            type: 'bullet',
            mesh,
            velocity: dir.clone().multiplyScalar(BULLET_SPEED),
            damage,
            owner,
            age: 0,
        });
    }

    function spawnArrow(origin, direction, damage, owner = 'player') {
        const dir = direction.clone().normalize();
        const mesh = makeArrowMesh();
        mesh.position.copy(origin);
        scene.add(mesh);
        projectiles.push({
            type: 'arrow',
            mesh,
            velocity: dir.clone().multiplyScalar(ARROW_SPEED),
            damage,
            owner,
            age: 0,
        });
    }

    function update(delta) {
        const colliders = getColliders();
        for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            p.age += delta;
            if (p.age >= MAX_LIFETIME) {
                scene.remove(p.mesh);
                p.mesh.geometry?.dispose();
                p.mesh.material?.dispose();
                projectiles.splice(i, 1);
                continue;
            }

            const from = p.mesh.position.clone();
            if (p.type === 'arrow') {
                p.velocity.y += ARROW_GRAVITY * delta;
                p.mesh.lookAt(from.clone().add(p.velocity.clone().normalize()));
            } else if (p.type === 'bullet') {
                p.velocity.y += BULLET_GRAVITY * delta;
            }
            p.mesh.position.addScaledVector(p.velocity, delta);
            const to = p.mesh.position.clone();

            // Check player hit first (non-player projectiles only) so skeleton arrows always register
            let hitPlayer = false;
            if (p.owner !== 'player' && getPlayerPosition && onHitPlayer) {
                const playerPos = getPlayerPosition();
                if (segmentIntersectsSphere(from, to, playerPos, playerRadius)) {
                    hitPlayer = true;
                }
            }
            const hit = hitPlayer ? null : hitTestSegment(from, to, null);
            if (!hit && !hitPlayer) continue;

            if (hit) hitPoint.copy(hit.point);
            scene.remove(p.mesh);
            p.mesh.geometry?.dispose();
            p.mesh.material?.dispose();
            projectiles.splice(i, 1);

            if (hitPlayer) {
                const dmg = Number(p.damage);
                onHitPlayer(Number.isFinite(dmg) && dmg > 0 ? dmg : 1);
            } else {
                const mobRoot = findMobRoot(hit.object);
                if (mobRoot && p.owner === 'player' && onHitMob) {
                    let damage = p.damage;
                    // Headshot detection: use mob world bounds and hit Y position.
                    mobBounds.setFromObject(mobRoot);
                    const height = mobBounds.max.y - mobBounds.min.y;
                    if (height > 0) {
                        const headY = mobBounds.min.y + height * HEADSHOT_THRESHOLD;
                        if (hitPoint.y >= headY) {
                            damage *= 2;
                        }
                    }
                    onHitMob(mobRoot, damage);
                }
            }
        }
    }

    return { spawnBullet, spawnArrow, update };
}
