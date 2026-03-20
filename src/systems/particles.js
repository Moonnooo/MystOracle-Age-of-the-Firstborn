import * as THREE from 'three';

export function createParticleSystem(scene, terrain, voxelSize = 0.5) {

    // Track all particles globally
    const particles = [];

    // Track particles per chunk key
    const chunkParticles = new Map(); // key: chunkKey, value: Set of particles


    // color: THREE.Color or hex or [r,g,b] (0..1)
    function spawn(origin, shooterDir, chunkKey = null, color = 0xaaaaaa) {
        const numParticles = 10;

        let matColor;
        if (Array.isArray(color)) {
            matColor = new THREE.Color().setRGB(color[0], color[1], color[2]);
        } else {
            matColor = new THREE.Color(color);
        }

        for (let i = 0; i < numParticles; i++) {
            const p = new THREE.Mesh(
                new THREE.BoxGeometry(voxelSize / 4, voxelSize / 4, voxelSize / 4),
                new THREE.MeshStandardMaterial({ color: matColor })
            );

            p.position.copy(origin);

            // Slight spread
            const spread = 0.5;
            const dir = shooterDir.clone().add(new THREE.Vector3(
                (Math.random() - 0.5) * spread,
                Math.random() * 0.3,
                (Math.random() - 0.5) * spread
            )).normalize();

            const speed = Math.random() * 0.15 + 0.05;
            p.velocity = dir.multiplyScalar(speed);

            // Random rotation
            p.rotation.set(
                Math.random() * Math.PI,
                Math.random() * Math.PI,
                Math.random() * Math.PI
            );

            p.angularVelocity = new THREE.Vector3(
                (Math.random() - 0.5) * 0.2,
                (Math.random() - 0.5) * 0.2,
                (Math.random() - 0.5) * 0.2
            );

            p.bounce = 0.5;
            p.resting = false;
            p.lifetime = 2000;

            scene.add(p);
            particles.push(p);

            // Register particle to its chunk
            if (chunkKey) {
                if (!chunkParticles.has(chunkKey)) chunkParticles.set(chunkKey, new Set());
                chunkParticles.get(chunkKey).add(p);
            }
        }
    }

    function update() {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];

            // Check if resting particle's support block still exists
            if (p.resting) {
                const bx = Math.floor(p.position.x);
                const bz = Math.floor(p.position.z);
                let topY = -Infinity;
                // Search downward from particle, not from terrain top
                const startY = Math.floor(p.position.y);
                for (let y = startY - 1; y >= Math.max(0, startY - 5); y--) {
                    if (terrain.getVoxelAt(bx, y, bz)) { topY = (y + 1) * terrain.voxelSize; break; }
                }
                
                if (topY === -Infinity || p.position.y > topY) {
                    // Block below is gone, resume falling
                    p.resting = false;
                    p.velocity.y = 0;
                }
            }

            if (!p.resting) {
                // Store previous position for collision detection
                const prevPos = p.position.clone();

                // Apply gravity
                p.velocity.y -= 0.006;

                // Apply velocity
                p.position.add(p.velocity);

                // Linear damping
                p.velocity.x *= 0.97;
                p.velocity.z *= 0.97;

                // Angular damping
                p.angularVelocity.multiplyScalar(0.94);
                if (p.angularVelocity.length() < 0.003) p.angularVelocity.set(0, 0, 0);

                // Apply rotation
                p.rotation.x += p.angularVelocity.x;
                p.rotation.y += p.angularVelocity.y;
                p.rotation.z += p.angularVelocity.z;

                // Collision: check if particle is inside terrain
                const bx = Math.floor(p.position.x);
                const by = Math.floor(p.position.y);
                const bz = Math.floor(p.position.z);
                
                // Check if current position is occupied
                if (terrain.getVoxelAt(bx, by, bz)) {
                    // Particle is inside a block
                    // Check if previous position was also inside (shouldn't happen, but safe check)
                    const prevBx = Math.floor(prevPos.x);
                    const prevBy = Math.floor(prevPos.y);
                    const prevBz = Math.floor(prevPos.z);
                    
                    if (!terrain.getVoxelAt(prevBx, prevBy, prevBz)) {
                        // We just entered a block - resolve collision
                        // Check the direction we came from
                        
                        // If we came from below (falling), snap to top of block
                        if (prevPos.y < p.position.y || Math.abs(p.velocity.y) > 0.001) {
                            // Falling or moving down - find the top surface
                            // Search from particle's current Y downward, not from terrain top
                            let surfaceY = -Infinity;
                            for (let y = by; y >= Math.max(0, by - 5); y--) {
                                if (terrain.getVoxelAt(bx, y, bz)) { 
                                    surfaceY = (y + 1) * terrain.voxelSize; 
                                    break; 
                                }
                            }
                            
                            if (surfaceY !== -Infinity) {
                                p.position.y = surfaceY;
                                
                                // Stop falling, apply friction to horizontal motion
                                p.velocity.y = 0;
                                p.velocity.x *= 0.5;
                                p.velocity.z *= 0.5;
                                
                                // Check if we've come to rest
                                if (p.velocity.length() < 0.02) {
                                    p.velocity.set(0, 0, 0);
                                    p.angularVelocity.set(0, 0, 0);
                                    const snap = angle => Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
                                    p.rotation.x = snap(p.rotation.x);
                                    p.rotation.y = snap(p.rotation.y);
                                    p.rotation.z = snap(p.rotation.z);
                                    p.resting = true;
                                }
                            }
                        } else {
                            // Came from the side or above - slide along surface
                            // Revert to previous position on X/Z
                            p.position.x = prevPos.x;
                            p.position.z = prevPos.z;
                            
                            // Kill horizontal velocity (can't go through blocks)
                            p.velocity.x *= 0.2;
                            p.velocity.z *= 0.2;
                            
                            // Keep falling if velocity allows
                            if (p.velocity.y > 0) {
                                p.velocity.y = 0; // Don't push up
                            }
                        }
                    }
                } else {
                    // Not in a block - check if we should be resting on terrain below
                    const groundBx = Math.floor(p.position.x);
                    const groundBz = Math.floor(p.position.z);
                    let groundY = -Infinity;
                    // Search downward from particle's position, not from terrain top
                    for (let y = Math.floor(p.position.y) - 1; y >= Math.max(0, Math.floor(p.position.y) - 5); y--) {
                        if (terrain.getVoxelAt(groundBx, y, groundBz)) { 
                            groundY = (y + 1) * terrain.voxelSize; 
                            break; 
                        }
                    }
                    
                    // If there's ground very close below and we're moving slowly, snap and rest
                    if (groundY !== -Infinity && p.position.y <= groundY + voxelSize / 2 && p.velocity.y <= 0) {
                        const distToGround = p.position.y - groundY;
                        if (distToGround < voxelSize / 8 && p.velocity.length() < 0.03) {
                            p.position.y = groundY;
                            p.velocity.set(0, 0, 0);
                            p.angularVelocity.set(0, 0, 0);
                            const snap = angle => Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
                            p.rotation.x = snap(p.rotation.x);
                            p.rotation.y = snap(p.rotation.y);
                            p.rotation.z = snap(p.rotation.z);
                            p.resting = true;
                        }
                    }
                }
            }

            // Lifetime
            p.lifetime--;
            if (p.lifetime <= 0) {
                scene.remove(p);
                particles.splice(i, 1);

                // Remove from chunk map if registered
                for (const [key, set] of chunkParticles) {
                    if (set.has(p)) {
                        set.delete(p);
                        if (set.size === 0) chunkParticles.delete(key);
                        break;
                    }
                }
            }
        }
    }

    // Remove all particles for a chunk by key (called when chunk unloads and particles were registered with that key)
    function removeChunkParticles(chunkKey) {
        if (!chunkParticles.has(chunkKey)) return;
        for (const p of chunkParticles.get(chunkKey)) {
            scene.remove(p);
            const idx = particles.indexOf(p);
            if (idx !== -1) particles.splice(idx, 1);
        }
        chunkParticles.delete(chunkKey);
    }

    // Remove particles whose position is inside the unloaded chunk (so unloaded areas show nothing)
    function removeParticlesInChunk(cx, cz) {
        const chunkSize = terrain && terrain.chunkSize != null ? terrain.chunkSize : 16;
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            const pcx = Math.floor(p.position.x / chunkSize);
            const pcz = Math.floor(p.position.z / chunkSize);
            if (pcx === cx && pcz === cz) {
                scene.remove(p);
                particles.splice(i, 1);
                const chunkKey = `${cx},${cz}`;
                if (chunkParticles.has(chunkKey)) chunkParticles.get(chunkKey).delete(p);
            }
        }
    }

    // Re-add particles for a chunk (called on chunk reload)
    function restoreChunkParticles(chunkKey) {
        if (!chunkParticles.has(chunkKey)) return;
        for (const p of chunkParticles.get(chunkKey)) {
            scene.add(p);
            if (!particles.includes(p)) particles.push(p);
        }
    }

    return {
        spawn,
        update,
        removeChunkParticles,
        removeParticlesInChunk,
        restoreChunkParticles
    };
}
