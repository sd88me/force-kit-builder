/*
 * Force Kit Builder — client app.
 *
 * Plain vanilla JS, no build step, no framework — matches nodeServer's own
 * zero-build convention (this file is served as a plain <script defer> tag,
 * see index.js's LIST()). All kit-building logic lives server-side (see
 * ../kitbuilder-core); this file only renders state and calls the JSON
 * actions documented in DESIGN.md's API section.
 *
 * The one thing this file calls OUTSIDE this plugin's own API is nodeServer's
 * existing `/file-browser/LIST` endpoint, reused as-is for the folder-picker
 * modal (source roots + export destination) — see DESIGN.md for why this
 * wasn't reimplemented.
 */
(function () {
    'use strict';

    let STATE = null;
    let selectedPad = null;
    let destDir = null;
    let browserTarget = null;     // 'root' | 'dest' — what the open modal is choosing for
    let browserPath = '/media';

    /* ---- API helpers ------------------------------------------------- */

    async function api(action, body) {
        const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch('/kit-builder/' + action, opts);
        let json;
        try { json = await res.json(); } catch (e) { throw new Error('bad response from server'); }
        if (!json.ok) throw new Error(json.error || 'request failed');
        return json;
    }

    async function fileBrowserList(path) {
        const res = await fetch('/file-browser/LIST', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ PATH: path })
        });
        return res.json();
    }

    function setStatus(msg, isError) {
        const el = document.getElementById('kb-status');
        el.textContent = msg || '';
        el.classList.toggle('kb-error', !!isError);
    }

    async function refresh() {
        const res = await fetch('/kit-builder/STATE');
        STATE = await res.json();
        render();
    }

    async function run(fn, okMsg) {
        try {
            await fn();
            await refresh();
            if (okMsg) setStatus(okMsg, false);
        } catch (e) {
            setStatus(String(e.message || e), true);
        }
    }

    /* ---- render -------------------------------------------------------- */

    function render() {
        if (!STATE || !STATE.ok) return;
        document.getElementById('kb-kitname').value = STATE.kit.name || '';
        document.getElementById('kb-skiploops').checked = !!(STATE.config.scan_filters && STATE.config.scan_filters.skip_loops);
        document.getElementById('kb-maxsize').value = (STATE.config.scan_filters && STATE.config.scan_filters.max_sample_size) || '';
        renderGrid();
        renderRoots();
        renderIndexSummary();
        renderPadDetail();
    }

    function iconBtn(label, on, onClick, extraClass) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = on ? ('kb-on ' + (extraClass || '')) : '';
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
    }

    function renderGrid() {
        const grid = document.getElementById('kb-grid');
        grid.innerHTML = '';
        const favs = STATE.favourites || [];
        const rejects = STATE.rejects || [];
        STATE.kit.pads.forEach((pad, i) => {
            const el = document.createElement('div');
            const cat = pad.sample ? pad.sample.category : pad.role;
            el.className = 'kb-pad kb-cat-' + cat;
            if (!pad.sample) el.classList.add('kb-empty');
            if (pad.locked) el.classList.add('kb-locked');
            if (pad.sample && pad.sample.missing) el.classList.add('kb-missing');
            if (selectedPad === i) el.classList.add('kb-selected');

            const top = document.createElement('div');
            top.className = 'kb-pad-top';
            const num = document.createElement('span');
            num.className = 'kb-pad-num';
            num.textContent = pad.pad;
            const icons = document.createElement('div');
            icons.className = 'kb-pad-icons';
            icons.appendChild(iconBtn('L', pad.locked, () => run(() => api('SET_PAD', { padIndex: i, action: 'toggle_lock' }))));
            const isFav = pad.sample && favs.indexOf(pad.sample.filesystem_path) !== -1;
            const isRej = pad.sample && rejects.indexOf(pad.sample.filesystem_path) !== -1;
            icons.appendChild(iconBtn('★', isFav, () => {
                if (!pad.sample) return;
                run(() => api('FAVREJECT', { path: pad.sample.filesystem_path, action: isFav ? 'clear' : 'favourite' }));
            }));
            icons.appendChild(iconBtn('✕', isRej, () => {
                if (!pad.sample) return;
                run(() => api('FAVREJECT', { path: pad.sample.filesystem_path, action: isRej ? 'clear' : 'reject' }));
            }, 'kb-reject-on'));
            top.appendChild(num);
            top.appendChild(icons);

            const poolSelect = document.createElement('select');
            poolSelect.className = 'kb-pad-pool';
            poolSelect.addEventListener('click', (e) => e.stopPropagation());
            const layoutEntry = (STATE.config.pad_layout && STATE.config.pad_layout[i]) || [];
            (STATE.categories || []).forEach((c) => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                if (layoutEntry.length === 1 && layoutEntry[0] === c) opt.selected = true;
                poolSelect.appendChild(opt);
            });
            poolSelect.title = 'Pool: ' + (layoutEntry.join(', ') || 'default');
            poolSelect.addEventListener('change', () => {
                run(() => api('SET_POOL', { padIndex: i, category: poolSelect.value }), 'Pad ' + pad.pad + ' pool set to ' + poolSelect.value);
            });

            const sample = document.createElement('div');
            sample.className = 'kb-pad-sample';
            sample.textContent = pad.sample ? pad.sample.filename : '(empty)';

            el.appendChild(top);
            el.appendChild(poolSelect);
            el.appendChild(sample);
            el.addEventListener('click', () => {
                selectedPad = i;
                if (pad.sample) playSample(pad.sample.filesystem_path);
                render();
            });
            grid.appendChild(el);
        });
    }

    function dbLabel(gain) {
        const g = Number(gain);
        if (!(g > 0)) return '-inf dB';
        const db = 20 * Math.log10(g);
        return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
    }

    function renderPadDetail() {
        const body = document.getElementById('kb-pad-detail-body');
        if (selectedPad == null) {
            body.innerHTML = '<p class="kb-muted">Select a pad to see its details.</p>';
            return;
        }
        const pad = STATE.kit.pads[selectedPad];
        const favs = STATE.favourites || [], rejects = STATE.rejects || [];
        body.innerHTML = '';

        const title = document.createElement('div');
        title.textContent = 'Pad ' + pad.pad + ' — ' + (pad.sample ? pad.sample.filename : 'empty');
        body.appendChild(title);

        if (pad.sample) {
            const path = document.createElement('div');
            path.className = 'kb-muted';
            path.textContent = pad.sample.filesystem_path;
            body.appendChild(path);
        }

        const gainLabel = document.createElement('label');
        gainLabel.textContent = 'Gain: ' + dbLabel(pad.playback.gain);
        const gainSlider = document.createElement('input');
        gainSlider.type = 'range';
        gainSlider.min = '0';
        gainSlider.max = '2';
        gainSlider.step = '0.01';
        gainSlider.value = pad.playback.gain;
        gainSlider.addEventListener('input', () => { gainLabel.textContent = 'Gain: ' + dbLabel(gainSlider.value); });
        gainSlider.addEventListener('change', () => {
            run(() => api('SET_PAD', { padIndex: selectedPad, action: 'gain', value: Number(gainSlider.value) }));
        });
        body.appendChild(gainLabel);
        body.appendChild(gainSlider);

        if (pad.sample) {
            const favCount = favs.length, rejCount = rejects.length;
            const counts = document.createElement('div');
            counts.className = 'kb-muted';
            counts.textContent = 'Library-wide: ' + favCount + ' favourite(s), ' + rejCount + ' reject(s)';
            body.appendChild(counts);
        }

        const row = document.createElement('div');
        row.className = 'kb-row';
        const rerollBtn = document.createElement('button');
        rerollBtn.textContent = 'Reroll';
        rerollBtn.disabled = pad.locked;
        rerollBtn.addEventListener('click', () => run(() => api('REROLL', { padIndex: selectedPad, preventDuplicates: document.getElementById('kb-dupes').checked })));
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear Pad';
        clearBtn.disabled = pad.locked || !pad.sample;
        clearBtn.addEventListener('click', () => run(() => api('SET_PAD', { padIndex: selectedPad, action: 'clear' })));
        row.appendChild(rerollBtn);
        row.appendChild(clearBtn);
        body.appendChild(row);
    }

    function renderRoots() {
        const ul = document.getElementById('kb-roots');
        ul.innerHTML = '';
        const roots = (STATE.config && STATE.config.sample_roots) || [];
        if (!roots.length) {
            const li = document.createElement('li');
            li.textContent = 'No sample folders selected yet.';
            ul.appendChild(li);
            return;
        }
        roots.forEach((r) => {
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.textContent = r;
            const rm = document.createElement('button');
            rm.textContent = 'Remove';
            rm.addEventListener('click', () => run(() => api('SET_ROOTS', { roots: roots.filter((x) => x !== r) })));
            li.appendChild(span);
            li.appendChild(rm);
            ul.appendChild(li);
        });
    }

    function renderIndexSummary() {
        const el = document.getElementById('kb-index-summary');
        const idx = STATE.index;
        if (!idx || !idx.present) { el.textContent = 'Not indexed yet — Rescan after adding a folder.'; return; }
        const s = idx.summary || {};
        el.textContent = idx.count + ' samples indexed (cut: ' + idx.skipped_loops + ' loop, ' + idx.skipped_oversize + ' oversize) — ' +
            'Kick ' + (s.kick || 0) + ', Snr ' + (s.snare || 0) + ', Clap ' + (s.clap || 0) + ', Hats ' + (s.hats || 0) +
            ', Tom ' + (s.toms || 0) + ', Perc ' + (s.perc || 0) + ', Cym ' + (s.cym || 0) + ', FX ' + (s.fx || 0) + ', Other ' + (s.other || 0);
    }

    /* ---- audition -------------------------------------------------------- */

    function playSample(path) {
        const audio = document.getElementById('kb-audio');
        audio.src = '/kit-builder/AUDIO/' + encodeURIComponent(path);
        audio.play().catch(() => { /* autoplay/format issues are non-fatal */ });
    }

    /* ---- folder-picker modal (reuses nodeServer's /file-browser/LIST) --- */

    function openBrowser(title, target, startPath) {
        browserTarget = target;
        browserPath = startPath || '/media';
        document.getElementById('kb-browser-title').textContent = title;
        document.getElementById('kb-browser-modal').classList.remove('kb-hidden');
        loadBrowserPath(browserPath);
    }

    function closeBrowser() {
        document.getElementById('kb-browser-modal').classList.add('kb-hidden');
    }

    async function loadBrowserPath(path) {
        const listing = await fileBrowserList(path);
        browserPath = path;
        document.getElementById('kb-browser-path').textContent = path;
        const ul = document.getElementById('kb-browser-list');
        ul.innerHTML = '';
        const folders = listing.FOLDERS || [];
        if (!folders.length) {
            const li = document.createElement('li');
            li.textContent = '(no subfolders)';
            li.style.cursor = 'default';
            ul.appendChild(li);
        }
        folders.forEach((f) => {
            const li = document.createElement('li');
            li.textContent = '📁 ' + f.name;
            li.addEventListener('click', () => loadBrowserPath(f.path));
            ul.appendChild(li);
        });
    }

    function browserUp() {
        const parts = browserPath.replace(/\/+$/, '').split('/');
        parts.pop();
        const parent = parts.join('/') || '/';
        loadBrowserPath(parent);
    }

    function browserSelect() {
        if (browserTarget === 'root') {
            const roots = ((STATE.config && STATE.config.sample_roots) || []).slice();
            if (roots.indexOf(browserPath) === -1) roots.push(browserPath);
            run(() => api('SET_ROOTS', { roots }));
        } else if (browserTarget === 'dest') {
            destDir = browserPath;
            document.getElementById('kb-destdir').textContent = destDir;
        }
        closeBrowser();
    }

    /* ---- toolbar / wiring -------------------------------------------------- */

    function wire() {
        document.getElementById('kb-kitname').addEventListener('change', (e) => {
            STATE.kit.name = e.target.value;
        });
        document.getElementById('kb-new').addEventListener('click', () => run(() => api('NEW_KIT'), 'New kit'));
        document.getElementById('kb-assign').addEventListener('click', () => run(() =>
            api('ASSIGN', { preventDuplicates: document.getElementById('kb-dupes').checked }), 'Assigned'));
        document.getElementById('kb-clear').addEventListener('click', () => run(() => api('CLEAR_ALL'), 'Cleared unlocked pads'));
        document.getElementById('kb-unlock').addEventListener('click', () => run(() => api('UNLOCK_ALL'), 'Unlocked all'));
        document.getElementById('kb-match').addEventListener('click', () => run(() => api('MATCH_LEVELS'), 'Levels matched'));
        document.getElementById('kb-save').addEventListener('click', () => run(() =>
            api('SAVE', { name: document.getElementById('kb-kitname').value, overwriteName: STATE.kit.name }), 'Saved'));

        document.getElementById('kb-add-root').addEventListener('click', () => openBrowser('Add a sample folder', 'root'));
        document.getElementById('kb-choose-dest').addEventListener('click', () => openBrowser('Choose export destination', 'dest'));
        document.getElementById('kb-browser-close').addEventListener('click', closeBrowser);
        document.getElementById('kb-browser-up').addEventListener('click', browserUp);
        document.getElementById('kb-browser-select').addEventListener('click', browserSelect);

        document.getElementById('kb-rescan').addEventListener('click', () => run(() => api('RESCAN', {
            scan_filters: {
                skip_loops: document.getElementById('kb-skiploops').checked,
                max_sample_size: document.getElementById('kb-maxsize').value || null
            }
        }), 'Rescanned'));

        document.getElementById('kb-export-btn').addEventListener('click', async () => {
            const resultEl = document.getElementById('kb-export-result');
            if (!destDir) { setStatus('Choose a destination folder first', true); return; }
            try {
                const r = await api('EXPORT', { name: document.getElementById('kb-kitname').value, destDir });
                resultEl.textContent = r.ok
                    ? 'Exported ' + r.padCount + ' pad(s) to ' + r.dir + (r.warnings.length ? ' (' + r.warnings.length + ' warning(s))' : '')
                    : 'Export failed: ' + (r.errors || []).join(', ');
                setStatus(r.ok ? 'Exported' : 'Export failed', !r.ok);
            } catch (e) {
                setStatus(String(e.message || e), true);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        wire();
        refresh();
    });
})();
