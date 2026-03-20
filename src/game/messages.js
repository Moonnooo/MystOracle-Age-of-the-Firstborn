// Simple message catalog for UI/status text, with basic support for
// multiple languages. Use t(key, vars) to look up a message and
// interpolate variables like {seconds}.
//
// Example:
//   t('status.worldDropsWarning', { seconds: 10 })
//   -> "World item drops will clear in 10 seconds."

const MESSAGES = {
    en: {
        status: {
            worldDropsWarning: 'World item drops will clear in {seconds} seconds.',
            worldDropsCleared: 'World item drops have been cleared.',
        },
        ui: {
            crafting: {
                title: 'Crafting',
                categories: {
                    building: 'Building',
                    tools: 'Tools & Weapons',
                    ammo: 'Ammo',
                    materials: 'Materials',
                    armor: 'Armor',
                    jewellery: 'Jewellery',
                    cosmetics: 'Cosmetics',
                    other: 'Other',
                },
            },
            equipment: {
                title: 'Equipment',
            },
            backpack: {
                title: 'Backpack',
            },
        },
    },
};

let currentLanguage = 'en';

export function setLanguage(lang) {
    if (MESSAGES[lang]) {
        currentLanguage = lang;
    }
}

export function t(key, vars = {}) {
    const parts = key.split('.');
    let node = MESSAGES[currentLanguage] || MESSAGES.en;
    for (const part of parts) {
        if (node && Object.prototype.hasOwnProperty.call(node, part)) {
            node = node[part];
        } else {
            node = null;
            break;
        }
    }
    if (typeof node !== 'string') {
        // Fallback: return the key so missing entries are obvious.
        return key;
    }
    return node.replace(/\{(\w+)\}/g, (_, name) => {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`;
    });
}

