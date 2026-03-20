// controls.js
import * as THREE from 'three';
import { playerHeight } from './player.js';
import { showStatusMessage } from '../ui/ui.js';
import { isWater } from '../world/blocksRegistry.js';


export function setupControls(player, camera, canvas, terrain, getBackpackOpen = () => false, getGamePaused = () => false, onFallDamage = null, mobSystem = null, getTreeSystem = () => null) {

    const keys = { w:false, a:false, s:false, d:false, space:false, shift:false };

    let yaw = 0;
    let pitch = 0;

    const speed = 4;
    const gravity = -20;
    const jumpForce = 8;

    let velocityY = 0;
    let onGround = false;
    let lastGroundY = player.position.y;
    let fallStartY = player.position.y;
    let wasOnGround = false;
    let targetGroundY = player.position.y; // for smooth up/down on blocks
    const GROUND_SMOOTH_SPEED = 10; // lerp toward ground Y (blocks per second)
    // Used to suppress bogus fall damage on the very first landing after spawn.
    // At startup the player is temporarily placed high in the air; we don't want
    // that initial \"drop\" to immediately hurt the player.
    let hasEverLanded = false;

    // Smooth step-up so walking over 1-block bumps feels natural instead of instant.
    const STEP_UP_HEIGHT = 1.0;
    const STEP_UP_SPEED = 6.0; // blocks per second when stepping up
    let pendingStepUp = 0;     // remaining vertical distance to interpolate up


    // --- Input ---
    let flySpeedMultiplier = 1.0; // Creative-mode fly speed (adjustable)

    window.addEventListener('keydown', e => {
        const k = e.key.toLowerCase();
        if (k in keys) keys[k] = true;
        if (k === ' ') keys.space = true;

        // Adjust creative fly speed with < (slower) and > (faster)
        // On most keyboards these are ',' and '.' unshifted.
        if (k === ',' || k === '<' || k === '.' || k === '>') {
            const isCreative = typeof window !== 'undefined' && typeof window.isCreativeMode === 'function'
                ? window.isCreativeMode()
                : false;
            if (isCreative && !getBackpackOpen() && !getGamePaused()) {
                if (k === ',' || k === '<') {
                    flySpeedMultiplier = Math.max(0.25, flySpeedMultiplier * 0.7);
                } else {
                    flySpeedMultiplier = Math.min(6.0, flySpeedMultiplier * 1.4);
                }
                const label = `${flySpeedMultiplier.toFixed(2).replace(/\.?0+$/, '')}×`;
                showStatusMessage(`Fly speed: ${label}`, 2200);
            }
        }
    });

    window.addEventListener('keyup', e => {
        const k = e.key.toLowerCase();
        if (k in keys) keys[k] = false;
        if (k === ' ') keys.space = false;
    });

    // --- Mouse look ---
    let pointerLocked = false;

    canvas.addEventListener('click', () => {
        // Don't request pointer lock if UI is open or game is paused
        if (getBackpackOpen() || getGamePaused()) return;
        
        // Request pointer lock with error handling
        const promise = canvas.requestPointerLock();
        if (promise !== undefined) {
            promise.catch(err => {
                // Silently handle errors (user may have exited lock, permission denied, etc.)
                // This is expected behavior and doesn't need to be logged
            });
        }
    });

    document.addEventListener('pointerlockchange', () => {
        pointerLocked = document.pointerLockElement === canvas;
        // Toggle CSS class so UI can react (crosshair, hint, etc.)
        document.body.classList.toggle('pointer-locked', pointerLocked);
        
        // Hide pointer hint when paused (pause menu shows instead)
        const pointerHint = document.getElementById('pointerHint');
        if (pointerHint && getGamePaused()) {
            pointerHint.style.display = 'none';
        }
    });

    // Handle pointer lock errors gracefully
    document.addEventListener('pointerlockerror', () => {
        // Silently handle pointer lock errors
        // This can happen when user exits lock before request completes
    });

    document.addEventListener('mousemove', e => {
        if (!pointerLocked) return;
        if (getGamePaused()) return; // Block mouse look when paused

        yaw -= e.movementX * 0.002;
        pitch -= e.movementY * 0.002;
        pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch));
    });




    // --- Stamina (sprinting, jumping, regen) ---
    let stamina = 1.0;             // 0.0–1.0
    const STAMINA_DRAIN = 0.4;     // per second while sprinting
    const STAMINA_REGEN_IDLE = 0.5;  // per second when standing still
    const STAMINA_REGEN_WALK = 0.2;  // per second when walking (no sprint)
    const STAMINA_JUMP_COST = 0.18;  // one-time drain per jump

    function updateMovement(delta) {
        // Don't move if backpack is open or game is paused
        if (getBackpackOpen() || getGamePaused()) {
            return;
        }

        // --- Horizontal movement ---
        const inputDir = new THREE.Vector3();

        if (keys.w) inputDir.z -= 1;
        if (keys.s) inputDir.z += 1;
        if (keys.a) inputDir.x -= 1;
        if (keys.d) inputDir.x += 1;

        const hasInput = inputDir.lengthSq() > 0;
        if (hasInput) inputDir.normalize();

        const yawQuat = new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);

        inputDir.applyQuaternion(yawQuat);

        const isCreative = typeof window !== 'undefined' && typeof window.isCreativeMode === 'function'
            ? window.isCreativeMode()
            : false;

        // Sprinting: hold Shift while moving forward (W) and have stamina > 0 (ignored in creative)
        const wantsSprint = !isCreative && keys.shift && keys.w && !keys.s && hasInput && stamina > 0;
        let speedMultiplier = 1.0;
        if (isCreative) {
            // In creative: use adjustable flySpeedMultiplier only; Shift is reserved for flying down.
            speedMultiplier = flySpeedMultiplier;
        } else {
            // In survival: Shift only affects sprinting
            if (wantsSprint) speedMultiplier = 1.8;
        }
        const moveSpeed = speed * speedMultiplier * delta;

        const newX = player.position.x + inputDir.x * moveSpeed;
        const newZ = player.position.z + inputDir.z * moveSpeed;

        // Check collision with mobs and push player away if overlapping
        let mobCollision = false;
        let pushAwayX = 0;
        let pushAwayZ = 0;
        if (mobSystem && mobSystem.mobMeshes) {
            const playerRadius = 0.3;
            const playerY = player.position.y;
            const currentPlayerX = player.position.x;
            const currentPlayerZ = player.position.z;
            
            for (const mobMesh of mobSystem.mobMeshes) {
                const mobType = mobMesh.userData.mobType;
                if (mobType) {
                    const mobRadius = 0.5; // Default mob radius
                    const mobX = mobMesh.position.x;
                    const mobZ = mobMesh.position.z;
                    
                    // Check both current position and new position for collision
                    const currentDist = Math.sqrt(
                        Math.pow(currentPlayerX - mobX, 2) + 
                        Math.pow(currentPlayerZ - mobZ, 2)
                    );
                    const newDist = Math.sqrt(
                        Math.pow(newX - mobX, 2) + 
                        Math.pow(newZ - mobZ, 2)
                    );
                    const combinedRadius = playerRadius + mobRadius;
                    
                    // Only check horizontal collision (ignore Y for movement)
                    if (Math.abs(playerY - mobMesh.position.y) < 2) {
                        // If currently overlapping, push away from mob so we exit fully (avoids bouncing/fall-through)
                        const margin = 0.02;
                        if (currentDist < combinedRadius + margin) {
                            const pushDir = new THREE.Vector3(
                                currentPlayerX - mobX,
                                0,
                                currentPlayerZ - mobZ
                            );
                            if (pushDir.length() > 0.01) {
                                pushDir.normalize();
                                const overlap = combinedRadius + margin - currentDist;
                                const pushAmount = Math.min(overlap, 0.3);
                                pushAwayX += pushDir.x * pushAmount;
                                pushAwayZ += pushDir.z * pushAmount;
                            }
                        }
                        if (newDist < combinedRadius + margin) mobCollision = true;
                    }
                }
            }
        }

        // Check collision with trees and push away when overlapping (so we don't stand inside and bounce)
        let treeCollision = false;
        const treeSys = getTreeSystem();
        const treePlayerRadius = 0.3;
        const treeRadius = 0.7;
        const treeCombined = treePlayerRadius + treeRadius;
        const treeMargin = 0.02;
        if (treeSys && treeSys.trees) {
            const playerY = player.position.y;
            const playerYMax = player.position.y + playerHeight;
            const currentPlayerX = player.position.x;
            const currentPlayerZ = player.position.z;
            for (const tree of treeSys.trees) {
                const box = tree.userData.collisionBox;
                if (!box) continue;
                const treeMinY = box.min.y;
                const treeMaxY = box.max.y;
                const verticalOverlap = !(playerYMax < treeMinY || playerY > treeMaxY);
                if (!verticalOverlap) continue;
                const tx = tree.position.x;
                const tz = tree.position.z;
                const currentDist = Math.sqrt(
                    (currentPlayerX - tx) ** 2 + (currentPlayerZ - tz) ** 2
                );
                const newDist = Math.sqrt((newX - tx) ** 2 + (newZ - tz) ** 2);
                if (currentDist < treeCombined + treeMargin) {
                    const pushDir = new THREE.Vector3(currentPlayerX - tx, 0, currentPlayerZ - tz);
                    if (pushDir.length() > 0.01) {
                        pushDir.normalize();
                        const overlap = treeCombined + treeMargin - currentDist;
                        const pushAmount = Math.min(overlap, 0.3);
                        pushAwayX += pushDir.x * pushAmount;
                        pushAwayZ += pushDir.z * pushAmount;
                    }
                }
                if (newDist < treeCombined + treeMargin) treeCollision = true;
            }
        }
        
        // Apply push-away to resolve current overlaps (only horizontal, never vertical)
        if (Math.abs(pushAwayX) > 0.01 || Math.abs(pushAwayZ) > 0.01) {
            const maxPush = 0.35;
            pushAwayX = Math.max(-maxPush, Math.min(maxPush, pushAwayX));
            pushAwayZ = Math.max(-maxPush, Math.min(maxPush, pushAwayZ));
            player.position.x += pushAwayX;
            player.position.z += pushAwayZ;
            // Ensure Y position is not affected
        }

        // --- Prevent head/camera from clipping into blocks: limit movement if head would enter a block ---
        const headY = player.position.y + playerHeight;
        const headBlockY = Math.floor(headY);
        const dx = newX - player.position.x;
        const dz = newZ - player.position.z;
        const moveLen = Math.sqrt(dx * dx + dz * dz);
        let moveScale = 1;
        if (moveLen > 0.001) {
            const steps = Math.max(2, Math.ceil(moveLen * 4));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const hx = player.position.x + dx * t;
                const hz = player.position.z + dz * t;
                const vx = Math.floor(hx);
                const vz = Math.floor(hz);
                const id1 = terrain.getVoxelAt(vx, headBlockY, vz);
                const id2 = terrain.getVoxelAt(vx, headBlockY - 1, vz);
                const solid = (id) => id && id !== 5 && !isWater(id);
                if (solid(id1) || solid(id2)) {
                    moveScale = Math.min(moveScale, (i - 1) / steps);
                    break;
                }
            }
        }
        const clampedNewX = player.position.x + dx * moveScale;
        const clampedNewZ = player.position.z + dz * moveScale;

        // --- Occupancy-based collision with auto step-up (check full footprint at destination so all directions work) ---
        const minY = Math.floor(player.position.y + 0.05);
        const maxY = Math.floor(player.position.y + playerHeight - 0.05);
        const COLLIDE_R = 0.35;
        const minBX = Math.floor(clampedNewX - COLLIDE_R);
        const maxBX = Math.floor(clampedNewX + COLLIDE_R);
        const minBZ = Math.floor(clampedNewZ - COLLIDE_R);
        const maxBZ = Math.floor(clampedNewZ + COLLIDE_R);

        let blocked = false;
        let blockAtFootLevel = false;
        const LOG_BLOCK_ID = 4;
        const LEAVES_BLOCK_ID = 5;
        for (let bx = minBX; bx <= maxBX; bx++) {
            for (let bz = minBZ; bz <= maxBZ; bz++) {
                for (let y = minY; y <= maxY; y++) {
                    const id = terrain.getVoxelAt(bx, y, bz);
                    if (id && id !== LEAVES_BLOCK_ID && !isWater(id)) {
                        blocked = true;
                        if (y === minY) blockAtFootLevel = true;
                    }
                }
            }
        }
        if (blockAtFootLevel) {
            let anyLogOrLeaves = false;
            for (let bx = minBX; bx <= maxBX && !anyLogOrLeaves; bx++) {
                for (let bz = minBZ; bz <= maxBZ; bz++) {
                    const id = terrain.getVoxelAt(bx, minY, bz);
                    if (id === LOG_BLOCK_ID || id === LEAVES_BLOCK_ID) anyLogOrLeaves = true;
                }
            }
            if (anyLogOrLeaves) blockAtFootLevel = false;
        }

        if (!blocked && !mobCollision && !treeCollision) {
            player.position.x = clampedNewX;
            player.position.z = clampedNewZ;
        } else {
            // Step up only when blocked by a one-block curb at our feet (not tree), and space above is clear in whole footprint
            if (onGround && blockAtFootLevel) {
                const stepMinY = minY + 1;
                const stepMaxY = maxY + 1;
                let canStepUp = true;
                for (let bx = minBX; bx <= maxBX && canStepUp; bx++) {
                    for (let bz = minBZ; bz <= maxBZ && canStepUp; bz++) {
                        for (let y = stepMinY; y <= stepMaxY; y++) {
                            const sid = terrain.getVoxelAt(bx, y, bz);
                            if (sid && !isWater(sid)) {
                                canStepUp = false;
                                break;
                            }
                        }
                    }
                }
                if (canStepUp) {
                    player.position.x = clampedNewX;
                    player.position.z = clampedNewZ;
                    if (pendingStepUp <= 0.0001) {
                        pendingStepUp = STEP_UP_HEIGHT;
                    }
                }
            }
        }

        // --- Ground check first when we were on ground (avoids gravity then lerp = bouncing) ---
        const belowY = Math.floor(player.position.y - 0.1);
        const FOOT_RADIUS = 0.35;
        const minGX = Math.floor(player.position.x - FOOT_RADIUS);
        const maxGX = Math.floor(player.position.x + FOOT_RADIUS);
        const minGZ = Math.floor(player.position.z - FOOT_RADIUS);
        const maxGZ = Math.floor(player.position.z + FOOT_RADIUS);
        const BLOCK_LOG = 4;
        const BLOCK_LEAVES = 5;
        let hasGround = false;
        let hasWalkableGround = false;
        for (let gx = minGX; gx <= maxGX; gx++) {
            for (let gz = minGZ; gz <= maxGZ; gz++) {
                const blockId = terrain.getVoxelAt(gx, belowY, gz);
                if (blockId && !isWater(blockId)) {
                    hasGround = true;
                    if (blockId !== BLOCK_LOG && blockId !== BLOCK_LEAVES) {
                        hasWalkableGround = true;
                    }
                }
            }
        }

        if (isCreative) {
            // In creative mode, disable gravity and fall damage; allow simple fly.
            velocityY = 0;
            const flySpeed = speed * 1.5;
            if (keys.space) player.position.y += flySpeed * delta;
            if (keys.shift) player.position.y -= flySpeed * delta;
            onGround = false;
            wasOnGround = false;
            pendingStepUp = 0;

            // Still apply yaw/pitch every frame so the camera moves with the mouse.
            player.rotation.y = yaw;
            camera.rotation.x = pitch;
            camera.rotation.z = 0;
            return;
        }

        if (hasGround) {
            velocityY = 0;
            if (hasWalkableGround) {
                targetGroundY = belowY + 1.001;
                const smoothStep = Math.min(1, GROUND_SMOOTH_SPEED * delta);
                player.position.y += (targetGroundY - player.position.y) * smoothStep;
            }
            if (keys.space && stamina >= STAMINA_JUMP_COST) {
                stamina -= STAMINA_JUMP_COST;
                velocityY = jumpForce;
                onGround = false;
            } else {
                onGround = true;
            }
            if (!wasOnGround && onFallDamage && hasEverLanded) {
                const fallDistance = fallStartY - player.position.y;
                if (fallDistance > 3) {
                    const damage = Math.floor((fallDistance - 3) * 2);
                    if (damage > 0) onFallDamage(damage);
                }
            }
            lastGroundY = player.position.y;
            wasOnGround = true;
            if (!hasEverLanded) {
                hasEverLanded = true;
                fallStartY = player.position.y;
            }
        } else {
            targetGroundY = player.position.y;
            if (wasOnGround) {
                fallStartY = lastGroundY;
            }
            onGround = false;
            wasOnGround = false;

            if (pendingStepUp <= 0) {
                velocityY += gravity * delta;
                if (keys.space && wasOnGround && stamina >= STAMINA_JUMP_COST) {
                    stamina -= STAMINA_JUMP_COST;
                    velocityY = jumpForce;
                }
            }
        }

        // Apply step-up (one block) when we hit a 1-block curb — run even when on ground so step-up actually happens
        if (pendingStepUp > 0) {
            const stepAmount = Math.min(pendingStepUp, STEP_UP_SPEED * delta);
            player.position.y += stepAmount;
            pendingStepUp -= stepAmount;
            velocityY = 0;
        }

        // Apply vertical velocity (jump/gravity) when not stepping up
        if (pendingStepUp <= 0 && !hasGround) {
            player.position.y += velocityY * delta;
            if (velocityY > 0) {
                const radius = 0.3;
                const minX = Math.floor(player.position.x - radius);
                const maxX = Math.floor(player.position.x + radius);
                const minZ = Math.floor(player.position.z - radius);
                const maxZ = Math.floor(player.position.z + radius);
                const headY = player.position.y + playerHeight;
                const minBlockY = Math.floor(player.position.y);
                const maxBlockY = Math.floor(headY + 0.01);
                let ceilingY = null;
                for (let vx = minX; vx <= maxX; vx++) {
                    for (let vz = minZ; vz <= maxZ; vz++) {
                        for (let vy = minBlockY; vy <= maxBlockY; vy++) {
                            const cid = terrain.getVoxelAt(vx, vy, vz);
                            if (cid && !isWater(cid)) {
                                if (headY > vy && player.position.y < vy + 1) {
                                    if (ceilingY === null || vy < ceilingY) ceilingY = vy;
                                }
                            }
                        }
                    }
                }
                if (ceilingY !== null) {
                    player.position.y = ceilingY - playerHeight - 0.001;
                    velocityY = 0;
                }
            }
        } else if (pendingStepUp <= 0 && hasGround && velocityY !== 0) {
            player.position.y += velocityY * delta;
            if (velocityY > 0) {
                const radius = 0.3;
                const minX = Math.floor(player.position.x - radius);
                const maxX = Math.floor(player.position.x + radius);
                const minZ = Math.floor(player.position.z - radius);
                const maxZ = Math.floor(player.position.z + radius);
                const headY = player.position.y + playerHeight;
                const minBlockY = Math.floor(player.position.y);
                const maxBlockY = Math.floor(headY + 0.01);
                let ceilingY = null;
                for (let vx = minX; vx <= maxX; vx++) {
                    for (let vz = minZ; vz <= maxZ; vz++) {
                        for (let vy = minBlockY; vy <= maxBlockY; vy++) {
                            const cid = terrain.getVoxelAt(vx, vy, vz);
                            if (cid && !isWater(cid)) {
                                if (headY > vy && player.position.y < vy + 1) {
                                    if (ceilingY === null || vy < ceilingY) ceilingY = vy;
                                }
                            }
                        }
                    }
                }
                if (ceilingY !== null) {
                    player.position.y = ceilingY - playerHeight - 0.001;
                    velocityY = 0;
                }
            }
        }

        // --- Stamina: drain when sprinting; regen when idle (faster) or walking (slower) ---
        if (hasInput && keys.shift && keys.w && !keys.s && stamina > 0) {
            stamina -= STAMINA_DRAIN * delta;
        } else if (!hasInput) {
            stamina += STAMINA_REGEN_IDLE * delta;
        } else if (hasInput && !keys.shift) {
            stamina += STAMINA_REGEN_WALK * delta;
        }
        stamina = Math.max(0, Math.min(1, stamina));
        if (!player.userData) player.userData = {};
        player.userData.stamina = stamina;

        player.rotation.y = yaw;
        camera.rotation.x = pitch;
        camera.rotation.z = 0;
    }

    function setYawPitch(newYaw, newPitch) {
        yaw = newYaw;
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, newPitch));
        player.rotation.y = yaw;
        camera.rotation.x = pitch;
        camera.rotation.z = 0;
    }

    // Reset input and vertical motion state when unpausing or returning focus
    function resetMovementState() {
        keys.w = false;
        keys.a = false;
        keys.s = false;
        keys.d = false;
        keys.space = false;
        keys.shift = false;
        velocityY = 0;
        pendingStepUp = 0;
    }

    return { updateMovement, setYawPitch, resetMovementState };
}
