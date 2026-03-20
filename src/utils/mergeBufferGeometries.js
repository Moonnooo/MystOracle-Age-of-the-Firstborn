import * as THREE from 'three';

/**
 * Merge an array of BufferGeometries into a single geometry
 * @param {THREE.BufferGeometry[]} geometries
 * @param {boolean} useGroups
 * @returns {THREE.BufferGeometry}
 */
export function mergeBufferGeometries(geometries, useGroups = false) {
    const mergedGeometry = new THREE.BufferGeometry();
    let offset = 0;

    for (let i = 0; i < geometries.length; i++) {
        const geometry = geometries[i];

        if (useGroups) {
            const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
            mergedGeometry.addGroup(offset, count, i);
        }

        for (const name in geometry.attributes) {
            if (!mergedGeometry.attributes[name]) {
                mergedGeometry.setAttribute(name, geometry.attributes[name].clone());
            } else {
                const existing = mergedGeometry.attributes[name];
                const array = new Float32Array(existing.array.length + geometry.attributes[name].array.length);
                array.set(existing.array, 0);
                array.set(geometry.attributes[name].array, existing.array.length);
                mergedGeometry.setAttribute(name, new THREE.BufferAttribute(array, geometry.attributes[name].itemSize));
            }
        }

        if (geometry.index) {
            if (!mergedGeometry.index) {
                mergedGeometry.setIndex(geometry.index.clone());
            } else {
                const array = new Uint32Array(mergedGeometry.index.array.length + geometry.index.array.length);
                array.set(mergedGeometry.index.array, 0);
                for (let j = 0; j < geometry.index.array.length; j++) {
                    array[mergedGeometry.index.array.length + j] = geometry.index.array[j] + offset;
                }
                mergedGeometry.setIndex(new THREE.BufferAttribute(array, 1));
            }
        }

        offset += geometry.attributes.position.count;
    }

    return mergedGeometry;
}
