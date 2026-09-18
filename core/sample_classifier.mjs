/*
 * Force Kit Builder — sample classification.
 *
 * This logic is entirely folder/filename based and has no platform-specific
 * dependency at all.
 *
 * Pure module: no filesystem access. Unit-tested by tests/test_classifier.js.
 *
 * Folder matching is primary:
 *  - case-insensitive
 *  - leading/trailing whitespace ignored
 *  - spaces, underscores and hyphens are equivalent  → we strip them all, so
 *    "open hat" / "open_hat" / "open-hat" / "openhat" all normalise the same
 *  - any directory component may match, not only the immediate parent
 *  - deepest (most nested) matching component wins
 *  - exactly one primary category per sample; unmatched → "other"
 *
 * Filename fallback (config `classify_filenames`, default on): when the
 * folder path yields nothing, classifyFilename() does a best-effort
 * token-exact keyword match on the file's own name. Folder structure always
 * wins over the filename.
 */

/* lowercase, trim, then remove every space / underscore / hyphen */
export function normalizeToken(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .trim()
        .replace(/[\s_-]+/g, '');
}

/*
 * Build a lookup from normalised folder alias -> role name.
 * `roleRules` is the `role_rules` object from the config. "other" is
 * excluded from the alias index — it is the default result, not a folder
 * match, and the deepest-match rule already keeps a nested subfolder from
 * demoting a sample to "other".
 */
export function buildAliasIndex(roleRules) {
    const index = new Map();
    for (const role of Object.keys(roleRules || {})) {
        if (role === 'other') continue;
        const aliases = (roleRules[role] && roleRules[role].folder_aliases) || [];
        for (const alias of aliases) {
            const key = normalizeToken(alias);
            if (key && !index.has(key)) index.set(key, role);
        }
    }
    return index;
}

/*
 * Split a filename into lowercase alphanumeric tokens: drop the directory and
 * extension, break camelCase and letter/digit boundaries, split on every other
 * separator. "Deep_Kick_01.wav" -> ["deep","kick","01"].
 */
export function tokenizeFilename(name) {
    return String(name == null ? '' : name)
        .replace(/^.*[\/\\]/, '')                 // basename only
        .replace(/\.[^.]+$/, '')                  // drop extension
        .replace(/([a-z])([A-Z])/g, '$1 $2')      // camelCase
        .replace(/([A-Za-z])(\d)/g, '$1 $2')      // letter|digit
        .replace(/(\d)([A-Za-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/*
 * Fallback classification from the filename alone (used only when the folder
 * path yields nothing). Best-effort keyword match: try contiguous joins of
 * up to 3 tokens, longest window first (so "open hat" beats bare "hat"),
 * first hit wins. Token-exact against the alias index — no substrings, so
 * "bassline" does NOT match "bass". Returns 'other' on no hit.
 */
export function classifyFilename(filename, aliasIndex) {
    const toks = tokenizeFilename(filename);
    for (let win = Math.min(3, toks.length); win >= 1; win--) {
        for (let i = 0; i + win <= toks.length; i++) {
            const hit = aliasIndex.get(toks.slice(i, i + win).join(''));
            if (hit) return hit;
        }
    }
    return 'other';
}

/*
 * Classify one sample. `dirComponents` are the directory names between the
 * sample root and the file (filename NOT included); walked shallow -> deep so
 * the deepest folder match wins. When that yields 'other' and `filename` is
 * given, fall back to classifyFilename(). Returns a role name, or 'other'.
 *
 *   classify(['Percussion', 'Closed Hat'], idx)              -> 'closed_hat'
 *   classify(['One Shots'], idx, 'punchy_kick_01.wav')       -> 'kick'
 *   classify(['Kicks'], idx, 'snare_layer.wav')              -> 'kick'  (folder wins)
 *   classify(['Textures'], idx)                              -> 'other'
 */
export function classify(dirComponents, aliasIndex, filename) {
    let role = 'other';
    for (const comp of dirComponents || []) {
        const hit = aliasIndex.get(normalizeToken(comp));
        if (hit) role = hit; // keep going: a deeper component may override
    }
    if (!filename) return role;

    if (role === 'other') {
        role = classifyFilename(filename, aliasIndex);
    } else if (role === 'hat') {
        /* A "Hi-Hats" folder is generic, but the file often says which kind
         * ("Hihat Closed …", "OH_909 …"). Promote hat -> closed/open when the
         * filename is specific. */
        const fn = classifyFilename(filename, aliasIndex);
        if (fn === 'closed_hat' || fn === 'open_hat') role = fn;
    }
    return role;
}
