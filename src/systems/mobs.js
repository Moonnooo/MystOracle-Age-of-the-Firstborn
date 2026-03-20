import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../assets/assetBase.js';
import { getEffectiveVolume } from '../game/audioSettings.js';
import { BLOCK_IDS } from '../world/blocksRegistry.js';
import { computeBaseHeight } from '../world/terrain/baseHeight.js';
import { getBiomeInfoAt, BIOMES } from '../world/terrain/biomes.js';

// Match projectiles.js for skeleton arrow aim (gravity compensation)
const ARROW_SPEED = 32;
const ARROW_GRAVITY_MAG = 28;

export function createMobSystem(scene, terrain, player = null, onPlayerDamage = null, getParticleSystem = null, getSkyTime = null, getIsInPlayerView = null, playerHeight = 1.6) {
    let spawnSkeletonArrow = null;
    /** When true: no AI, no new spawns, hidden, not in raycasts. */
    let mobsDisabled = false;
    const mobs = [];
    const mobMeshes = [];
    const mobsByChunk = new Map();
    const mobStateByChunk = new Map();
    const modelLoader = new GLTFLoader();
    const loadedModels = new Map(); // Cache for loaded GLTF models
    
    // Mob type definitions. modelForwardAxis: which way the model "faces" at rotation 0 in the GLTF (-Z, +Z, +X, -X).
    const MOB_TYPES = {
        // Passive animals: keep all existing drops, plus a chance to drop essences later if desired
        cow:    { color: 0x886633, speed: 1.2, radius: 0.6, drops: ['raw_beef', 'leather', 'bone'], hostile: false, modelPath: ASSET_BASE + 'models/cow.glb',   modelForwardAxis: '+Z' },
        sheep:  { color: 0xffffff, speed: 1.0, radius: 0.55, drops: ['raw_mutton', 'wool', 'bone'],    hostile: false, modelPath: ASSET_BASE + 'models/sheep.glb', modelForwardAxis: '+Z' },
        // Passive bird: flocks flying above the plains
        bird:   { color: 0xffee88, speed: 2.4, radius: 0.35, drops: ['bone', 'feather'], hostile: false, modelPath: ASSET_BASE + 'models/bird.glb', modelForwardAxis: '+Z', flying: true },
        // Goblins: plains-only melee hostile
        goblin: { color: 0xff0000, speed: 2.5, radius: 1.0, drops: ['bone', 'essence'], hostile: true, modelPath: ASSET_BASE + 'models/little_rambling.glb', attackRange: 2.0, attackDamage: 5, attackCooldown: 1.0, modelForwardAxis: '-Z' },
        // Skeletons: desert-only ranged hostile (uses sphere placeholder if no model)
        skeleton: { color: 0xdddddd, speed: 1.8, radius: 0.6, drops: ['bone', 'arrow'], hostile: true, attackRange: 18.0, attackDamage: 4, attackCooldown: 1.6 }
    };

    // --- Shared die sound (used by all mobs) ---
    let dieAudio = null;
    let dieAudioLastTime = 0;
    const DIE_SOUND_COOLDOWN = 1.0; // seconds between global die sounds

    function playSharedDieSound() {
        if (typeof Audio === 'undefined') return;
        const now = performance.now() / 1000;
        if (now - dieAudioLastTime < DIE_SOUND_COOLDOWN) return;
        // Randomly skip some deaths so it doesn't feel spammy when many die at once
        if (Math.random() > 0.7) return;
        if (!dieAudio) {
            dieAudio = new Audio(ASSET_BASE + 'sounds/shared/die.mp3');
        }
        dieAudio.volume = 0.8 * getEffectiveVolume();
        // Do not overlap; if it's already playing, skip
        if (!dieAudio.paused) return;
        dieAudioLastTime = now;
        dieAudio.currentTime = 0;
        try {
            dieAudio.play();
        } catch (e) {
            // Ignore play errors (autoplay restrictions, etc.)
        }
    }

    // --- Shared head/body impact sound (for hits that don't kill immediately) ---
    let impactAudio = null;
    let impactAudioLastTime = 0;
    const IMPACT_COOLDOWN = 0.08;

    function playHeadBodyImpactSound() {
        if (typeof Audio === 'undefined') return;
        const now = performance.now() / 1000;
        if (now - impactAudioLastTime < IMPACT_COOLDOWN) return;
        if (!impactAudio) {
            impactAudio = new Audio(ASSET_BASE + 'sounds/shared/head_body_impact.mp3');
        }
        impactAudio.volume = 0.9 * getEffectiveVolume();
        if (!impactAudio.paused) return;
        impactAudioLastTime = now;
        impactAudio.currentTime = 0;
        try {
            impactAudio.play();
        } catch (e) {
            // Ignore autoplay / play errors
        }
    }

    // --- Cow ambient moo sound (shared for all cows) ---
    let cowMooAudio = null;
    let cowMooLastTime = 0;
    const COW_MOO_COOLDOWN = 10; // seconds between moos globally

    function playCowMooSound() {
        if (typeof Audio === 'undefined') return;
        const now = performance.now() / 1000;
        if (now - cowMooLastTime < COW_MOO_COOLDOWN) return;
        if (!cowMooAudio) {
            cowMooAudio = new Audio(ASSET_BASE + 'sounds/shared/cow_moo.mp3');
        }
        cowMooAudio.volume = 0.7 * getEffectiveVolume();
        if (!cowMooAudio.paused) return;
        cowMooLastTime = now;
        cowMooAudio.currentTime = 0;
        try {
            cowMooAudio.play();
        } catch (e) {
            // Ignore autoplay / play errors
        }
    }

    // --- Goblin approach sound (global per mob system) ---
    let goblinAudio = null;
    let goblinAudioLastTime = 0;
    const GOBLIN_SOUND_COOLDOWN = 8; // seconds between goblin approach sounds (global)
    let gameStartTime = null; // set on first update(); no growl in first N seconds so spawn doesn't trigger it

    function playGoblinApproachSound() {
        // In case Audio is not available (some environments), fail silently
        if (typeof Audio === 'undefined') return;
        const now = performance.now() / 1000;
        // Don't play on spawn: a goblin can already be in range when chunks first load.
        if (gameStartTime != null && now - gameStartTime < 14) return;
        if (now - goblinAudioLastTime < GOBLIN_SOUND_COOLDOWN) return;
        // Random chance so multiple goblins don't all growl every cooldown
        if (Math.random() > 0.6) return;
        if (!goblinAudio) {
            goblinAudio = new Audio(ASSET_BASE + 'sounds/goblin/goblin.mp3');
        }
        goblinAudio.volume = 0.7 * getEffectiveVolume();
        // Don't overlap sounds; wait for current to finish
        if (!goblinAudio.paused) return;
        goblinAudioLastTime = now;
        goblinAudio.currentTime = 0;
        try {
            goblinAudio.play();
        } catch (e) {
            // Ignore play errors (e.g. user hasn't interacted with page yet)
        }
    }

    // Compute rotation Y so the model's forward direction aligns with moveDir (horizontal).
    function rotationYForDirection(moveDir, def) {
        const axis = (def && def.modelForwardAxis) ? def.modelForwardAxis : '-Z';
        const offset = (def && def.modelForwardOffset) ? def.modelForwardOffset : 0;
        let angle;
        if (axis === '-Z') {
            angle = Math.atan2(moveDir.x, -moveDir.z);
        } else if (axis === '+Z') {
            angle = Math.atan2(moveDir.x, moveDir.z);
        } else if (axis === '+X') {
            angle = Math.atan2(-moveDir.z, moveDir.x);
        } else if (axis === '-X') {
            angle = Math.atan2(moveDir.z, -moveDir.x);
        } else {
            angle = Math.atan2(moveDir.x, -moveDir.z);
        }
        return angle + offset;
    }

    // Normalize angle difference to [-PI, PI] for shortest turn
    function angleDiff(target, current) {
        let d = target - current;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    const TURN_SPEED_RAD_PER_SEC = 2.5;

    // Load GLTF model for a mob type (with caching)
    async function loadMobModel(type) {
        const def = MOB_TYPES[type];
        if (!def || !def.modelPath) return null;
        
        if (loadedModels.has(type)) {
            return loadedModels.get(type);
        }
        
        try {
            const gltf = await modelLoader.loadAsync(def.modelPath);
            const model = gltf.scene.clone(true);
            // Setup model: enable shadows, scale appropriately
            model.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
            // Scale model to target height (2m for little_rambling) with uniform scale so proportions stay correct
            const bbox = new THREE.Box3().setFromObject(model);
            const modelSize = bbox.getSize(new THREE.Vector3());
            const center = bbox.getCenter(new THREE.Vector3());
            const targetHeight = def.radius * 2;
            const modelHeight = modelSize.y;
            if (modelHeight > 0) {
                const scale = targetHeight / modelHeight;
                model.scale.set(scale, scale, scale);
            }
            // Center the model at origin (so bottom sits on ground when positioned)
            model.position.sub(center);
            loadedModels.set(type, model);
            return model;
        } catch (err) {
            return null;
        }
    }

    // --- Time/shadow-based spawn chance for hostile mobs ---
    // Night: 22–6, Day: 10–16, Dawn/dusk in between. Shadow = block(s) above spawn (cave, under tree).
    function isSpawnInShadow(wx, top, wz) {
        if (!terrain.getVoxelAt) return false;
        const height = terrain.height != null ? terrain.height : 32;
        for (let y = top + 2; y <= Math.min(top + 5, height - 1); y++) {
            if (terrain.getVoxelAt(Math.floor(wx), y, Math.floor(wz))) return true;
        }
        return false;
    }

    function chooseMobTypeForSpawn(wx, wz, top) {
        const time = typeof getSkyTime === 'function' ? getSkyTime() : 12;
        const isNight = time < 6 || time >= 22;
        const isDay = time >= 10 && time < 16;
        const inShadow = isSpawnInShadow(wx, top, wz);

        // Determine biome at this spawn location so we can:
        // - Restrict goblins to the PLAINS starting area
        // - Restrict skeletons to the DESERT ring
        const baseHeight = computeBaseHeight(wx, wz);
        const biomeInfo = getBiomeInfoAt(wx, wz, baseHeight);
        const biome = biomeInfo.biome;
        const desertBlend = biomeInfo.desertBlend ?? 0;

        // Goblins: plains-only. Start with existing time/shadow logic, then
        // zero it out if not in PLAINS biome.
        let goblinChance = 0.2;
        if (isDay && !inShadow) goblinChance = 0.05;
        else if (isNight) goblinChance = 0.55;
        else if (inShadow) goblinChance = 0.45;
        if (inShadow && isNight) goblinChance = 0.7;
        if (biome !== BIOMES.PLAINS && biome !== BIOMES.FOREST) goblinChance = 0;

        // Skeletons: cold / high biomes (legacy desert still counts if present).
        let skeletonChance = 0;
        if (biome === BIOMES.MOUNTAINS || (biome === BIOMES.DESERT && desertBlend > 0.4)) {
            if (isNight) skeletonChance = 0.72;
            else if (isDay && !inShadow) skeletonChance = 0.28;
            else skeletonChance = 0.45;
        }

        const rand = Math.random();
        if (rand < skeletonChance) return 'skeleton';
        if (rand < skeletonChance + goblinChance) return 'goblin';
        if (biome === BIOMES.DESERT && desertBlend > 0.3) {
            return 'skeleton';
        }
        const passiveStart = skeletonChance + goblinChance;
        const passiveSpan = 0.4;
        if (biome === BIOMES.PLAINS || biome === BIOMES.FOREST) {
            if (rand < passiveStart + passiveSpan * 0.25) return 'bird';
            if (rand < passiveStart + passiveSpan * 0.65) return 'cow';
            if (rand < passiveStart + passiveSpan) return 'sheep';
        } else if (biome !== BIOMES.MOUNTAINS) {
            if (rand < passiveStart + passiveSpan * 0.5) return 'cow';
            if (rand < passiveStart + passiveSpan) return 'sheep';
        }
        return 'sheep';
    }

    // Decide if a mob is allowed to spawn at a given world position.
    // Rules:
    // - No mobs spawn directly in the player's line of sight.
    // - Hostile mobs additionally must not spawn too close to the player.
    const MIN_HOSTILE_SPAWN_DIST = 12; // world units (≈blocks)

    function canSpawnAt(type, wx, wy, wz) {
        const def = MOB_TYPES[type];
        const pos = new THREE.Vector3(wx + 0.5, wy, wz + 0.5);

        // Block spawns in player view (any mob type)
        if (typeof getIsInPlayerView === 'function' && getIsInPlayerView(pos)) {
            return false;
        }

        // Extra safety for hostile mobs: don't spawn too close to player
        if (def && def.hostile && player) {
            const playerPos = new THREE.Vector3();
            player.getWorldPosition(playerPos);
            const dx = pos.x - playerPos.x;
            const dz = pos.z - playerPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < MIN_HOSTILE_SPAWN_DIST * MIN_HOSTILE_SPAWN_DIST) {
                return false;
            }
        }

        return true;
    }

    // Core mob spawn function - spawns at terrain surface
    async function spawnMob(type, x, z) {
        const def = MOB_TYPES[type];
        if (!def) return null;
        
        // Find walkable ground (ignore leaves so we don't spawn on top of trees)
        let top = -1;
        if (terrain.getWalkableSurfaceYAt) {
            top = terrain.getWalkableSurfaceYAt(x, z);
        } else if (terrain.getSurfaceYAt) {
            top = terrain.getSurfaceYAt(x, z);
        } else {
            // Fallback: scan from top down
            for (let yy = terrain.height - 1; yy >= 0; yy--) {
                if (terrain.getVoxelAt(Math.floor(x), yy, Math.floor(z))) { 
                    top = yy; 
                    break; 
                }
            }
        }
        
        if (top < 0) return null;
        
        let mesh;
        // Try to use GLTF model if available
        if (def.modelPath) {
            const model = await loadMobModel(type);
            if (model) {
                mesh = model.clone(true);
            }
        }
        
        // Fallback to sphere if no model or model failed to load
        if (!mesh) {
            mesh = new THREE.Mesh(
                new THREE.SphereGeometry(def.radius, 8, 8),
                new THREE.MeshLambertMaterial({ color: def.color })
            );
        }
        
        // Position model - for GLTF, position so bottom (feet) sits on surface
        if (def.modelPath && mesh !== new THREE.Mesh()) {
            mesh.position.set(0, 0, 0);
            mesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(mesh);
            const modelBottom = bbox.min.y;
            mesh.userData.modelBottomY = modelBottom;
            mesh.position.set(x + 0.5, top + 1 - modelBottom, z + 0.5);
        } else {
            // Sphere fallback
            mesh.position.set(x + 0.5, top + 1 + def.radius + 0.01, z + 0.5);
        }
        // Birds fly at a fixed altitude above the terrain: ~34 blocks high
        if (type === 'bird') {
            const worldHeight = terrain.height != null ? terrain.height : 64;
            const groundY = top + 1;
            const desired = groundY + 34;
            const maxY = worldHeight - 2;
            mesh.position.y = Math.min(maxY, desired);
        }
        mesh.userData.mobType = type;
        // Propagate mobType to all child meshes for raycast detection
        mesh.traverse((child) => {
            if (child.isMesh || child.isObject3D) {
                child.userData.mobType = type;
            }
        });
        scene.add(mesh);
        
        const mob = {
            type,
            mesh,
            health: def.hostile ? 15 : 10, // Hostile mobs have more health
            speed: def.speed * (0.7 + Math.random() * 0.6),
            wanderTimer: 0,
            target: null,
            hostile: def.hostile || false,
            attackCooldown: 0,
            attackRange: def.attackRange || 0,
            attackDamage: def.attackDamage || 0,
            cactusDamageCooldown: 0,
        };
        mobs.push(mob);
        mobMeshes.push(mesh);
        
        // Register mob to chunk
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const key = `${cx},${cz}`;
        const arr = mobsByChunk.get(key) || [];
        arr.push(mesh);
        mobsByChunk.set(key, arr);
        
        return mob;
    }
    
    // Synchronous spawn wrapper (for compatibility) - spawns immediately with fallback
    function spawnMobSync(type, x, z) {
        const def = MOB_TYPES[type];
        if (!def) return null;
        
        // Find walkable ground (ignore leaves so we don't spawn on top of trees)
        let top = -1;
        if (terrain.getWalkableSurfaceYAt) {
            top = terrain.getWalkableSurfaceYAt(x, z);
        } else if (terrain.getSurfaceYAt) {
            top = terrain.getSurfaceYAt(x, z);
        } else {
            for (let yy = terrain.height - 1; yy >= 0; yy--) {
                if (terrain.getVoxelAt(Math.floor(x), yy, Math.floor(z))) { 
                    top = yy; 
                    break; 
                }
            }
        }
        if (top < 0) return null;
        
        let mesh;
        // Try to use cached model if available
        if (def.modelPath && loadedModels.has(type)) {
            mesh = loadedModels.get(type).clone(true);
        } else {
            // Fallback to sphere
            mesh = new THREE.Mesh(
                new THREE.SphereGeometry(def.radius, 8, 8),
                new THREE.MeshLambertMaterial({ color: def.color })
            );
            // Try to load model in background for next spawn
            if (def.modelPath) {
                loadMobModel(type).catch(() => {});
            }
        }
        
        // Position model - for GLTF, position so bottom (feet) sits on surface
        if (def.modelPath && loadedModels.has(type)) {
            mesh.position.set(0, 0, 0);
            mesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(mesh);
            const modelBottom = bbox.min.y;
            mesh.userData.modelBottomY = modelBottom;
            mesh.position.set(x + 0.5, top + 1 - modelBottom, z + 0.5);
        } else {
            // Sphere fallback
            mesh.position.set(x + 0.5, top + 1 + def.radius + 0.01, z + 0.5);
        }
        if (type === 'bird') {
            const worldHeight = terrain.height != null ? terrain.height : 64;
            const groundY = top + 1;
            const desired = groundY + 34;
            const maxY = worldHeight - 2;
            mesh.position.y = Math.min(maxY, desired);
        }
        mesh.userData.mobType = type;
        // Propagate mobType to all child meshes for raycast detection
        mesh.traverse((child) => {
            if (child.isMesh || child.isObject3D) {
                child.userData.mobType = type;
            }
        });
        scene.add(mesh);
        
        const mob = {
            type,
            mesh,
            health: def.hostile ? 15 : 10,
            speed: def.speed * (0.7 + Math.random() * 0.6),
            wanderTimer: 0,
            target: null,
            hostile: def.hostile || false,
            attackCooldown: 0,
            attackRange: def.attackRange || 0,
            attackDamage: def.attackDamage || 0,
            cactusDamageCooldown: 0,
        };
        mobs.push(mob);
        mobMeshes.push(mesh);
        
        // Register mob to chunk
        const chunkSize = terrain.chunkSize || 16;
        const cx = Math.floor(x / chunkSize);
        const cz = Math.floor(z / chunkSize);
        const key = `${cx},${cz}`;
        const arr = mobsByChunk.get(key) || [];
        arr.push(mesh);
        mobsByChunk.set(key, arr);
        
        return mob;
    }

    // Mob respawn timer per chunk
    const respawnTimers = new Map();
    const RESPAWN_TIME = 10; // seconds to respawn after all mobs in chunk are dead
    const TARGET_TOTAL_MOBS = 52; // cap total mobs; scale per-chunk count so low render distance = more per chunk, high = fewer
    const MAX_MOBS_PER_CHUNK_CAP = 3;

    function getMaxMobsPerChunk() {
        const numChunks = terrain.chunks ? terrain.chunks.size : 0;
        if (numChunks <= 0) return 0;
        const perChunk = Math.floor(TARGET_TOTAL_MOBS / numChunks);
        return Math.min(MAX_MOBS_PER_CHUNK_CAP, Math.max(0, perChunk));
    }

    function setMobsEnabled(enabled) {
        mobsDisabled = !enabled;
        for (const mesh of mobMeshes) {
            if (mesh) mesh.visible = enabled;
        }
    }

    function isMobsEnabled() {
        return !mobsDisabled;
    }

    function update(delta, playerPos) {
        if (mobsDisabled) return;
        if (gameStartTime == null) gameStartTime = performance.now() / 1000;
        // Only update mobs in loaded chunks
        const loadedChunks = new Set();
        if (terrain.chunks) {
            for (const key of terrain.chunks.keys()) loadedChunks.add(key);
        }
        
        // Mob AI update
        for (const mob of mobs) {
            // Only update if mob is in a loaded chunk
            const chunkSize = terrain.chunkSize || 16;
            const cx = Math.floor(mob.mesh.position.x / chunkSize);
            const cz = Math.floor(mob.mesh.position.z / chunkSize);
            const key = `${cx},${cz}`;
            if (!loadedChunks.has(key)) continue;
            
            mob.attackCooldown = Math.max(0, mob.attackCooldown - delta);
            
            // Hostile mobs chase/attack the player
            if (mob.hostile && player) {
                const playerPos = new THREE.Vector3();
                player.getWorldPosition(playerPos);
                const distToPlayer = mob.mesh.position.distanceTo(playerPos);
                
                if (mob.type === 'goblin') {
                    // Goblin approach sound: play when a goblin gets reasonably close but isn't yet attacking.
                    if (distToPlayer < 12 && distToPlayer > (mob.attackRange + 0.5)) {
                        playGoblinApproachSound();
                    }
                    
                    // If player is within detection range (20 blocks), chase them
                    if (distToPlayer < 20) {
                        mob.target = playerPos.clone();
                        mob.wanderTimer = 2.0; // Keep chasing for 2 seconds
                        
                        // Melee attack when close
                        if (distToPlayer < mob.attackRange && mob.attackCooldown <= 0) {
                            if (onPlayerDamage) {
                                onPlayerDamage(mob.attackDamage);
                            }
                            mob.attackCooldown = MOB_TYPES[mob.type].attackCooldown || 1.0;
                        }
                    } else {
                        // Player too far, wander
                        mob.wanderTimer -= delta;
                        if (mob.wanderTimer <= 0) {
                            const dx = (Math.random() - 0.5) * 8;
                            const dz = (Math.random() - 0.5) * 8;
                            const tx = mob.mesh.position.x + dx;
                            const tz = mob.mesh.position.z + dz;
                            
                            let ty = 0;
                            if (terrain.getWalkableSurfaceYAt) {
                                ty = terrain.getWalkableSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else if (terrain.getSurfaceYAt) {
                                ty = terrain.getSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else {
                                for (let yy = terrain.height - 1; yy >= 0; yy--) {
                                    if (terrain.getVoxelAt(Math.floor(tx), yy, Math.floor(tz))) { 
                                        ty = yy + 1; 
                                        break; 
                                    }
                                }
                            }
                            mob.target = new THREE.Vector3(tx + 0.5, ty + 0.5, tz + 0.5);
                            mob.wanderTimer = 1 + Math.random() * 3;
                        }
                    }
                } else if (mob.type === 'skeleton') {
                    // Skeletons prefer to keep some distance and shoot arrows (ranged damage).
                    const desiredMin = 6;
                    const desiredMax = 18;
                    const withinEngage = distToPlayer < 24;
                    
                    if (withinEngage) {
                        // Move toward player if very far, or back off slightly if too close
                        if (distToPlayer > desiredMax) {
                            mob.target = playerPos.clone();
                        } else if (distToPlayer < desiredMin) {
                            // Step backwards away from player to keep some range
                            const dirAway = new THREE.Vector3().subVectors(mob.mesh.position, playerPos).setY(0);
                            if (dirAway.length() > 0.01) {
                                dirAway.normalize();
                                const backPos = mob.mesh.position.clone().addScaledVector(dirAway, 4);
                                let ty = 0;
                                if (terrain.getWalkableSurfaceYAt) {
                                    ty = terrain.getWalkableSurfaceYAt(backPos.x, backPos.z);
                                    if (ty >= 0) ty = ty + 1;
                                } else if (terrain.getSurfaceYAt) {
                                    ty = terrain.getSurfaceYAt(backPos.x, backPos.z);
                                    if (ty >= 0) ty = ty + 1;
                                } else {
                                    for (let yy = terrain.height - 1; yy >= 0; yy--) {
                                        if (terrain.getVoxelAt(Math.floor(backPos.x), yy, Math.floor(backPos.z))) {
                                            ty = yy + 1;
                                            break;
                                        }
                                    }
                                }
                                mob.target = new THREE.Vector3(backPos.x + 0.5, ty + 0.5, backPos.z + 0.5);
                            }
                        } else {
                            // Stand ground and shoot
                            mob.target = mob.mesh.position.clone();
                        }
                        mob.wanderTimer = 2.0;
                        
                        // Ranged attack when in line-of-sight band: spawn visible arrow or instant damage
                        if (distToPlayer >= desiredMin && distToPlayer <= mob.attackRange && mob.attackCooldown <= 0) {
                            // Aim at player center (same as projectile hit sphere) and compensate for arrow gravity
                            const aimTarget = playerPos.clone();
                            aimTarget.y += playerHeight * 0.5;
                            const t = Math.max(0.1, distToPlayer / ARROW_SPEED);
                            const drop = 0.5 * ARROW_GRAVITY_MAG * t * t;
                            aimTarget.y += drop;
                            const dirToPlayer = aimTarget.sub(mob.mesh.position).normalize();
                            if (typeof spawnSkeletonArrow === 'function') {
                                spawnSkeletonArrow(mob.mesh.position.clone(), dirToPlayer, mob.attackDamage);
                            } else if (onPlayerDamage) {
                                onPlayerDamage(mob.attackDamage);
                            }
                            mob.attackCooldown = MOB_TYPES[mob.type].attackCooldown || 1.5;
                        }
                    } else {
                        // Too far: wander like passive mobs
                        mob.wanderTimer -= delta;
                        if (mob.wanderTimer <= 0) {
                            const dx = (Math.random() - 0.5) * 8;
                            const dz = (Math.random() - 0.5) * 8;
                            const tx = mob.mesh.position.x + dx;
                            const tz = mob.mesh.position.z + dz;
                            
                            let ty = 0;
                            if (terrain.getWalkableSurfaceYAt) {
                                ty = terrain.getWalkableSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else if (terrain.getSurfaceYAt) {
                                ty = terrain.getSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else {
                                for (let yy = terrain.height - 1; yy >= 0; yy--) {
                                    if (terrain.getVoxelAt(Math.floor(tx), yy, Math.floor(tz))) { 
                                        ty = yy + 1; 
                                        break; 
                                    }
                                }
                            }
                            mob.target = new THREE.Vector3(tx + 0.5, ty + 0.5, tz + 0.5);
                            mob.wanderTimer = 1 + Math.random() * 3;
                        }
                    }
                } else {
                    // Fallback for any other hostile types (treat like simple melee)
                    if (distToPlayer < 20) {
                        mob.target = playerPos.clone();
                        mob.wanderTimer = 2.0;
                        if (distToPlayer < (mob.attackRange || 2) && mob.attackCooldown <= 0) {
                            if (onPlayerDamage) {
                                onPlayerDamage(mob.attackDamage || 3);
                            }
                            mob.attackCooldown = MOB_TYPES[mob.type].attackCooldown || 1.0;
                        }
                    } else {
                        mob.wanderTimer -= delta;
                        if (mob.wanderTimer <= 0) {
                            const dx = (Math.random() - 0.5) * 8;
                            const dz = (Math.random() - 0.5) * 8;
                            const tx = mob.mesh.position.x + dx;
                            const tz = mob.mesh.position.z + dz;
                            
                            let ty = 0;
                            if (terrain.getWalkableSurfaceYAt) {
                                ty = terrain.getWalkableSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else if (terrain.getSurfaceYAt) {
                                ty = terrain.getSurfaceYAt(tx, tz);
                                if (ty >= 0) ty = ty + 1;
                            } else {
                                for (let yy = terrain.height - 1; yy >= 0; yy--) {
                                    if (terrain.getVoxelAt(Math.floor(tx), yy, Math.floor(tz))) { 
                                        ty = yy + 1; 
                                        break; 
                                    }
                                }
                            }
                            mob.target = new THREE.Vector3(tx + 0.5, ty + 0.5, tz + 0.5);
                            mob.wanderTimer = 1 + Math.random() * 3;
                        }
                    }
                }
            } else {
                // Passive mobs just wander
                
                // Cow ambient moo when player is nearby (non-spammy)
                if (mob.type === 'cow' && player) {
                    const playerPos = new THREE.Vector3();
                    player.getWorldPosition(playerPos);
                    const distToPlayer = mob.mesh.position.distanceTo(playerPos);
                    if (distToPlayer < 14) {
                        // Roughly 1 moo every ~10–20 seconds when near, thanks to cooldown + random
                        if (Math.random() < delta * 0.05) {
                            playCowMooSound();
                        }
                    }
                }

                mob.wanderTimer -= delta;
                if (!mob.target || mob.wanderTimer <= 0) {
                    // pick a new target nearby
                    const dx = (Math.random() - 0.5) * 8;
                    const dz = (Math.random() - 0.5) * 8;
                    const tx = mob.mesh.position.x + dx;
                    const tz = mob.mesh.position.z + dz;
                    
                    // find walkable ground y (ignore leaves)
                    let ty = 0;
                    if (terrain.getWalkableSurfaceYAt) {
                        ty = terrain.getWalkableSurfaceYAt(tx, tz);
                        if (ty >= 0) ty = ty + 1;
                    } else if (terrain.getSurfaceYAt) {
                        ty = terrain.getSurfaceYAt(tx, tz);
                        if (ty >= 0) ty = ty + 1;
                    } else {
                        for (let yy = terrain.height - 1; yy >= 0; yy--) {
                            if (terrain.getVoxelAt(Math.floor(tx), yy, Math.floor(tz))) { 
                                ty = yy + 1; 
                                break; 
                            }
                        }
                    }
                    // Birds fly at a fixed altitude above the terrain (~34 blocks); others stay on the ground.
                    if (mob.type === 'bird') {
                        const worldHeight = terrain.height != null ? terrain.height : 64;
                        const groundY = ty;
                        const desired = groundY + 34;
                        const maxY = worldHeight - 2;
                        const flyY = Math.min(maxY, desired);
                        mob.target = new THREE.Vector3(tx + 0.5, flyY, tz + 0.5);
                    } else {
                        mob.target = new THREE.Vector3(tx + 0.5, ty + 0.5, tz + 0.5);
                    }
                    mob.wanderTimer = 1 + Math.random() * 3;
                }
            }

            // move toward target
            const dir = new THREE.Vector3().subVectors(mob.target, mob.mesh.position);
            const dist = dir.length();
            if (dist > 0.1) {
                dir.normalize();
                const moveAmount = mob.speed * delta;
                const newPos = mob.mesh.position.clone().addScaledVector(dir, moveAmount);

                // Birds: fly at ~34 blocks above terrain. Climb quickly over hills; descend slowly over dips
                // so they don't jerk down when the ground drops one block (more realistic flight).
                if (mob.type === 'bird') {
                    const worldHeight = terrain.height != null ? terrain.height : 64;
                    let groundY = -1;
                    if (terrain.getWalkableSurfaceYAt) {
                        groundY = terrain.getWalkableSurfaceYAt(newPos.x, newPos.z);
                    } else if (terrain.getSurfaceYAt) {
                        groundY = terrain.getSurfaceYAt(newPos.x, newPos.z);
                    } else {
                        for (let yy = worldHeight - 1; yy >= 0; yy--) {
                            if (terrain.getVoxelAt(Math.floor(newPos.x), yy, Math.floor(newPos.z))) {
                                groundY = yy;
                                break;
                            }
                        }
                    }
                    if (groundY >= 0) {
                        const desiredY = groundY + 34;
                        const currentY = mob.mesh.position.y;
                        if (desiredY > currentY) {
                            // Terrain rose (hill/mountain): climb so we don't clip
                            const climbSpeed = 12;
                            newPos.y = Math.min(desiredY, currentY + climbSpeed * delta);
                        } else if (desiredY < currentY) {
                            // Terrain dropped: glide down slowly so small dips don't jerk the bird
                            const descentSpeed = 1.5; // blocks per second max
                            newPos.y = Math.max(desiredY, currentY - descentSpeed * delta);
                        }
                    }
                    if (newPos.y > worldHeight - 2) newPos.y = worldHeight - 2;
                }
                
                // Check collision with other mobs and player
                const def = MOB_TYPES[mob.type];
                const mobRadius = def?.radius || 0.5;
                let canMove = true;
                
                // Check collision with player
                if (player) {
                    const playerPos = new THREE.Vector3();
                    player.getWorldPosition(playerPos);
                    const playerRadius = 0.3;
                    const combinedRadius = mobRadius + playerRadius;
                    
                    const distToPlayer = new THREE.Vector3(
                        newPos.x - playerPos.x,
                        0, // Only horizontal distance
                        newPos.z - playerPos.z
                    ).length();
                    
                    if (distToPlayer < combinedRadius + 0.1 && Math.abs(newPos.y - playerPos.y) < 2) {
                        // Collision with player - push away from player
                        const pushDir = new THREE.Vector3(
                            newPos.x - playerPos.x,
                            0, // Only horizontal push
                            newPos.z - playerPos.z
                        );
                        if (pushDir.length() > 0.01) {
                            pushDir.normalize();
                            const pushDistance = combinedRadius + 0.1 - distToPlayer;
                            newPos.x += pushDir.x * pushDistance;
                            newPos.z += pushDir.z * pushDistance;
                        }
                        canMove = false;
                    }
                }
                
                // Check collision with other mobs
                for (const otherMob of mobs) {
                    if (otherMob === mob) continue;
                    const otherDef = MOB_TYPES[otherMob.type];
                    const otherRadius = otherDef?.radius || 0.5;
                    const combinedRadius = mobRadius + otherRadius;
                    
                    const distToOther = new THREE.Vector3(
                        newPos.x - otherMob.mesh.position.x,
                        0, // Only horizontal distance
                        newPos.z - otherMob.mesh.position.z
                    ).length();
                    
                    if (distToOther < combinedRadius + 0.1) {
                        // Collision detected - push away from other mob
                        const pushDir = new THREE.Vector3(
                            newPos.x - otherMob.mesh.position.x,
                            0, // Only horizontal push
                            newPos.z - otherMob.mesh.position.z
                        );
                        if (pushDir.length() > 0.01) {
                            pushDir.normalize();
                            const pushDistance = combinedRadius + 0.1 - distToOther;
                            newPos.x += pushDir.x * pushDistance;
                            newPos.z += pushDir.z * pushDistance;
                        }
                        canMove = false;
                        break;
                    }
                }
                
                // Only move if no collision or after push-away
                mob.mesh.position.copy(newPos);
                
                // Smoothly face movement direction
                const moveDir = dir.clone();
                moveDir.y = 0;
                if (moveDir.length() > 0.01) {
                    moveDir.normalize();
                    const targetY = rotationYForDirection(moveDir, def);
                    const currentY = mob.mesh.rotation.y;
                    const diff = angleDiff(targetY, currentY);
                    const turnRate = TURN_SPEED_RAD_PER_SEC * delta;
                    const step = Math.sign(diff) * Math.min(turnRate, Math.abs(diff));
                    mob.mesh.rotation.y = currentY + step;
                }
            }

            // keep mob on ground (smooth up and down) – skip for birds (they fly). Use walkable surface so mobs don't climb onto leaves.
            if (mob.type !== 'bird') {
                const mx = Math.floor(mob.mesh.position.x);
                const mz = Math.floor(mob.mesh.position.z);
                let top = -1;
                if (terrain.getWalkableSurfaceYAt) {
                    top = terrain.getWalkableSurfaceYAt(mx, mz);
                } else if (terrain.getSurfaceYAt) {
                    top = terrain.getSurfaceYAt(mx, mz);
                } else {
                    for (let yy = terrain.height - 1; yy >= 0; yy--) {
                        if (terrain.getVoxelAt(mx, yy, mz)) { 
                            top = yy; 
                            break; 
                        }
                    }
                }
                if (top >= 0) {
                    const def = MOB_TYPES[mob.type];
                    let desiredY;
                    if (mob.mesh.userData.modelBottomY !== undefined) {
                        desiredY = top + 1 - mob.mesh.userData.modelBottomY;
                    } else {
                        desiredY = top + 1 + (def?.radius || 0.5) + 0.01;
                    }
                    const currentY = mob.mesh.position.y;
                    const SMOOTH_SPEED = 5; // blocks per second for both up and down
                    const step = (desiredY - currentY) * Math.min(1, SMOOTH_SPEED * delta);
                    mob.mesh.position.y = currentY + step;
                }
            }

            // Cactus contact damage for mobs: small periodic damage while
            // overlapping cactus blocks, with a short cooldown so they don't
            // instantly die if stuck.
            if (terrain.getVoxelAt) {
                mob.cactusDamageCooldown = Math.max(0, mob.cactusDamageCooldown - delta);
                if (mob.cactusDamageCooldown <= 0) {
                    const cx = mob.mesh.position.x;
                    const cy = mob.mesh.position.y;
                    const cz = mob.mesh.position.z;
                    const def = MOB_TYPES[mob.type];
                    const radius = def?.radius || 0.5;
                    const minY = Math.floor(cy);
                    const maxY = Math.floor(cy + Math.max(1, radius * 2));
                    const offsets = [
                        [0, 0],
                        [radius * 0.7, 0],
                        [-radius * 0.7, 0],
                        [0, radius * 0.7],
                        [0, -radius * 0.7],
                    ];
                    let hitCactus = false;
                    for (const [ox, oz] of offsets) {
                        const vx = Math.floor(cx + ox);
                        const vz = Math.floor(cz + oz);
                        for (let vy = minY; vy <= maxY; vy++) {
                            if (terrain.getVoxelAt(vx, vy, vz) === BLOCK_IDS.CACTUS) {
                                hitCactus = true;
                                break;
                            }
                        }
                        if (hitCactus) break;
                    }
                    if (hitCactus) {
                        damageMob(mob.mesh, 2);
                        mob.cactusDamageCooldown = 0.5;
                    }
                }
            }
        }

        // Mob respawn logic: for each loaded chunk, if no mobs, start/advance respawn timer
        for (const key of loadedChunks) {
            const arr = mobsByChunk.get(key) || [];
            if (arr.length === 0) {
                // Start or advance timer
                let t = respawnTimers.get(key) || 0;
                t += delta;
                if (t >= RESPAWN_TIME) {
                    const maxPerChunk = getMaxMobsPerChunk();
                    const [cx, cz] = key.split(',').map(Number);
                    for (let i = 0; i < maxPerChunk; i++) {
                        const rx = cx * (terrain.chunkSize || 16) + Math.floor(Math.random() * (terrain.chunkSize || 16));
                        const rz = cz * (terrain.chunkSize || 16) + Math.floor(Math.random() * (terrain.chunkSize || 16));
                        
                        // find walkable surface (don't spawn on top of leaves)
                        let top = -1;
                        if (terrain.getWalkableSurfaceYAt) {
                            top = terrain.getWalkableSurfaceYAt(rx, rz);
                        } else if (terrain.getSurfaceYAt) {
                            top = terrain.getSurfaceYAt(rx, rz);
                        } else {
                            for (let yy = terrain.height - 1; yy >= 0; yy--) {
                                if (terrain.getVoxelAt(rx, yy, rz)) { 
                                    top = yy; 
                                    break; 
                                }
                            }
                        }
                        if (top < 0) continue;
                        const type = chooseMobTypeForSpawn(rx, top, rz);
                        // Skip spawns that would appear in player view or too close (for hostile)
                        if (!canSpawnAt(type, rx, top + 1, rz)) continue;
                        spawnMob(type, rx, rz).catch(() => {});
                    }
                    respawnTimers.set(key, 0);
                } else {
                    respawnTimers.set(key, t);
                }
            } else {
                // If there are mobs, reset timer
                respawnTimers.set(key, 0);
            }
        }

        // Dawn despawn: when it's day, hostile mobs outside player view can despawn (no drops)
        if (typeof getSkyTime === 'function' && typeof getIsInPlayerView === 'function') {
            const time = getSkyTime();
            const isDayForDespawn = time >= 6.5 && time < 20;
            if (isDayForDespawn) {
                const DESPAWN_RATE = 0.4;
                for (let i = mobs.length - 1; i >= 0; i--) {
                    const mob = mobs[i];
                    if (!mob.hostile) continue;
                    const pos = mob.mesh.position;
                    if (getIsInPlayerView(pos)) continue;
                    if (Math.random() < delta * DESPAWN_RATE) {
                        removeMobSilently(mob.mesh);
                    }
                }
            }
        }
    }

    // Called when a chunk is loaded - spawns mobs in new chunks
    function onChunkLoad(cx, cz) {
        const key = `${cx},${cz}`;
        
        // Restore mobs if any were saved
        if (mobStateByChunk.has(key)) {
            const mobStates = mobStateByChunk.get(key);
            for (const state of mobStates) {
                spawnMob(state.type, state.x, state.z).then(mob => {
                    if (mob) {
                        mob.mesh.position.copy(state.position);
                        mob.health = state.health;
                    }
                }).catch(() => {});
            }
            mobStateByChunk.delete(key);
        } else if (!mobsDisabled) {
            const maxPerChunk = getMaxMobsPerChunk();
            for (let i = 0; i < maxPerChunk; i++) {
                const rx = cx * (terrain.chunkSize || 16) + Math.floor(Math.random() * (terrain.chunkSize || 16));
                const rz = cz * (terrain.chunkSize || 16) + Math.floor(Math.random() * (terrain.chunkSize || 16));
                
                // find walkable surface (don't spawn on top of leaves)
                let top = -1;
                if (terrain.getWalkableSurfaceYAt) {
                    top = terrain.getWalkableSurfaceYAt(rx, rz);
                } else if (terrain.getSurfaceYAt) {
                    top = terrain.getSurfaceYAt(rx, rz);
                } else {
                    for (let yy = terrain.height - 1; yy >= 0; yy--) {
                        if (terrain.getVoxelAt(rx, yy, rz)) { 
                            top = yy; 
                            break; 
                        }
                    }
                }
                if (top < 0) continue;
                const type = chooseMobTypeForSpawn(rx, top, rz);
                if (!canSpawnAt(type, rx, top + 1, rz)) continue;
                spawnMob(type, rx, rz).catch(err => console.warn('Failed to spawn mob:', err));
            }
        }
        if (mobsDisabled) {
            for (const mesh of mobMeshes) {
                if (mesh) mesh.visible = false;
            }
        }
    }

    // Called when a chunk is unloaded
    function onChunkUnload(cx, cz) {
        const key = `${cx},${cz}`;
        const arr = mobsByChunk.get(key) || [];
        const mobStates = [];
        for (const mesh of arr) {
            const idx = mobMeshes.indexOf(mesh);
            if (idx !== -1) {
                const mob = mobs[idx];
                mobStates.push({
                    type: mob.type,
                    x: mesh.position.x,
                    z: mesh.position.z,
                    position: mesh.position.clone(),
                    health: mob.health
                });
                scene.remove(mesh);
                mobs.splice(idx, 1);
                mobMeshes.splice(idx, 1);
            } else {
                scene.remove(mesh);
            }
        }
        if (mobStates.length > 0) mobStateByChunk.set(key, mobStates);
        mobsByChunk.delete(key);
    }

    function getStateForSave() {
        const arr = [];
        for (let i = 0; i < mobs.length; i++) {
            const mob = mobs[i];
            const mesh = mobMeshes[i];
            if (!mesh) continue;
            arr.push({
                type: mob.type,
                x: mesh.position.x,
                y: mesh.position.y,
                z: mesh.position.z,
                health: mob.health
            });
        }
        return arr;
    }

    function clearAll() {
        for (const mesh of mobMeshes.slice()) {
            if (scene.children.includes(mesh)) scene.remove(mesh);
        }
        mobs.length = 0;
        mobMeshes.length = 0;
        mobsByChunk.clear();
        mobStateByChunk.clear();
    }

    async function restoreFromSave(data) {
        clearAll();
        if (!Array.isArray(data) || data.length === 0) return;
        for (const state of data) {
            const bx = Math.floor(state.x - 0.5);
            const bz = Math.floor(state.z - 0.5);
            try {
                const mob = await spawnMob(state.type, bx, bz);
                if (mob) {
                    mob.mesh.position.set(state.x, state.y, state.z);
                    mob.health = state.health;
                }
            } catch (e) {
                // ignore spawn errors
            }
        }
    }

    function getRaycastBlockers() {
        if (mobsDisabled) return [];
        return mobMeshes.slice();
    }

    // Get mob data by mesh (for look-at UI: name + health)
    function getMobByMesh(obj) {
        let rootMesh = null;
        if (mobMeshes.indexOf(obj) !== -1) {
            rootMesh = obj;
        } else {
            let check = obj;
            while (check) {
                if (mobMeshes.indexOf(check) !== -1) {
                    rootMesh = check;
                    break;
                }
                check = check.parent;
            }
        }
        if (!rootMesh) return null;
        const idx = mobMeshes.indexOf(rootMesh);
        if (idx === -1) return null;
        const mob = mobs[idx];
        const def = MOB_TYPES[mob.type];
        const maxHealth = def ? (def.hostile ? 15 : 10) : 10;
        return { type: mob.type, health: mob.health, maxHealth };
    }

    // Damage a mob and return drops if it dies
    function damageMob(obj, damage = 5) {
        // Find the root mob mesh by searching through our stored meshes
        // The hit object might be a child mesh, so we need to find the parent that's in mobMeshes
        let rootMesh = null;
        
        // First, check if the hit object itself is in mobMeshes
        if (mobMeshes.indexOf(obj) !== -1) {
            rootMesh = obj;
        } else {
            // Walk up the parent chain to find a mesh that's in mobMeshes
            let check = obj;
            while (check && !rootMesh) {
                if (mobMeshes.indexOf(check) !== -1) {
                    rootMesh = check;
                    break;
                }
                check = check.parent;
            }
            
            // If still not found, search through all mob meshes to find one that contains this object
            if (!rootMesh) {
                for (const storedMesh of mobMeshes) {
                    // Check if obj is the storedMesh or a child of it
                    let check = obj;
                    while (check) {
                        if (check === storedMesh) {
                            rootMesh = storedMesh;
                            break;
                        }
                        check = check.parent;
                    }
                    if (rootMesh) break;
                }
            }
        }
        
        if (!rootMesh) return null;
        
        // Find the mob in our arrays
        const idx = mobMeshes.indexOf(rootMesh);
        if (idx === -1) return null;
        const mob = mobs[idx];
        
        // Apply damage
        mob.health -= damage;
        
        // If mob dies, kill it and return drops
        if (mob.health <= 0) {
            return killMobByMesh(rootMesh);
        } else {
            // Play head/body impact sound for non-lethal hits
            playHeadBodyImpactSound();
        }
        
        return null; // Mob still alive
    }
    
    function removeMobFromChunkMap(obj) {
        for (const [key, arr] of mobsByChunk.entries()) {
            const i = arr.indexOf(obj);
            if (i !== -1) {
                arr.splice(i, 1);
                if (arr.length === 0) mobsByChunk.delete(key);
                else mobsByChunk.set(key, arr);
                break;
            }
        }
    }

    // Remove hostile mob without drops/sound/particles (e.g. dawn despawn)
    function removeMobSilently(mesh) {
        const idx = mobMeshes.indexOf(mesh);
        if (idx === -1) return;
        scene.remove(mesh);
        mobs.splice(idx, 1);
        mobMeshes.splice(idx, 1);
        removeMobFromChunkMap(mesh);
    }

    // Kill a mob (works for both passive animals and aggressive enemies)
    // Spawns blood particles, removes from scene, and returns drops
    function killMobByMesh(obj) {
        const idx = mobMeshes.indexOf(obj);
        if (idx === -1) return null;
        const mob = mobs[idx];
        
        // Play shared die sound for all mobs (animals and goblins)
        playSharedDieSound();
        
        // Spawn blood particles at mob position (same for all mobs - animals and enemies)
        const particleSystem = getParticleSystem ? getParticleSystem() : null;
        if (particleSystem) {
            const bloodColor = [0.8, 0.1, 0.1]; // Dark red
            const particleOrigin = obj.position.clone();
            particleOrigin.y += 0.5; // Spawn particles at center of mob
            const particleDir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() * 0.5 + 0.5,
                (Math.random() - 0.5) * 2
            ).normalize();
            particleSystem.spawn(particleOrigin, particleDir, null, bloodColor);
        }

        // Remove from scene (mob disappears)
        scene.remove(obj);
        mobs.splice(idx, 1);
        mobMeshes.splice(idx, 1);
        
        removeMobFromChunkMap(obj);

        // return drops
        const def = MOB_TYPES[mob.type];
        if (!def || !def.drops) return [];
        const drops = [];
        // Always drop the first item (primary drop)
        if (def.drops[0]) {
            drops.push(def.drops[0]);
        }
        // Chance to drop second item (if it exists)
        if (def.drops[1] && Math.random() < 0.6) {
            drops.push(def.drops[1]);
        }
        // Chance to drop third item (if it exists)
        if (def.drops[2] && Math.random() < 0.3) {
            drops.push(def.drops[2]);
        }
        return drops;
    }

    // helper: spawn a few initial mobs for testing (removed - mobs spawn via chunk load now)
    function spawnInitial() {
        // No longer needed - mobs spawn when chunks load
    }

    /** Snap any mobs in the column (vx, vz) to sit on top of the given surface Y (block top). */
    function snapMobsInColumn(vx, vz, surfaceTopY) {
        const topY = surfaceTopY + 1;
        for (let i = 0; i < mobMeshes.length; i++) {
            const mesh = mobMeshes[i];
            if (Math.floor(mesh.position.x) !== vx || Math.floor(mesh.position.z) !== vz) continue;
            const mob = mobs[i];
            const def = MOB_TYPES[mob?.type];
            if (mesh.userData.modelBottomY !== undefined) {
                mesh.position.y = topY - mesh.userData.modelBottomY;
            } else {
                mesh.position.y = topY + (def?.radius ?? 0.5) + 0.01;
            }
        }
    }

    function setSpawnSkeletonArrow(fn) {
        spawnSkeletonArrow = fn;
    }

    return {
        mobs,
        mobMeshes,
        spawnMob: spawnMobSync,
        spawnInitial,
        update,
        getRaycastBlockers,
        getMobByMesh,
        damageMob,
        killMobByMesh,
        onChunkLoad,
        onChunkUnload,
        snapMobsInColumn,
        getStateForSave,
        clearAll,
        restoreFromSave,
        setSpawnSkeletonArrow,
        setMobsEnabled,
        isMobsEnabled,
    };
}
