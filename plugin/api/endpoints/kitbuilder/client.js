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
    let browserTarget = null;     // 'root' | 'dest' | 'xpm-file' — what the open modal is choosing for
    let browserPath = '/media';
    const waveformCache = new Map();   // filesystem_path -> {min,max}[] peak buckets from the server, or null

    // Confirmed live on real hardware 2026-09-18 (see DESIGN.md): factory
    // expansion kits live flat here, .xpm beside .wav, no manifest needed.
    // This only seeds where the destination browser opens to — it is never
    // auto-selected, the user still has to browse in and hit Select.
    const SUGGESTED_EXPORT_DIR = '/media/az01-internal-sd/Expansions/Kits & Patterns';

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
            if (pad.sample) {
                const wf = document.createElement('canvas');
                wf.className = 'kb-pad-waveform';
                wf.width = 110;    // internal pixel buffer — small on purpose, CSS
                wf.height = 32;    // stretches it to fill the tile's flexible middle
                el.appendChild(wf);
                drawWaveform(wf, pad.sample.filesystem_path);
            }
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
            const canvas = document.createElement('canvas');
            canvas.id = 'kb-waveform';
            canvas.width = 260;
            canvas.height = 60;
            body.appendChild(canvas);
            drawWaveform(canvas, pad.sample.filesystem_path);
        }

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

    /* ---- waveform (small per-pad preview + a larger one in the side panel) -
     *
     * Peaks are computed SERVER-SIDE (`/kit-builder/PEAKS/...`, core/
     * wav_peaks.mjs), not via the browser's decodeAudioData() — that API is
     * strict about "valid" WAV shapes and was silently rejecting real
     * sample-pack content (24-bit PCM, extended `fmt ` headers, BWF metadata
     * chunks) that's perfectly well-formed, which is exactly why some pads
     * showed no waveform at all. The server's hand-rolled parser (shared with
     * wav_rms.mjs's loudness measurement) doesn't have that problem, and this
     * also means only one thing ever decodes each file, not once per browser
     * that happens to load this page.
     *
     * Peaks always come back as a fixed 128-bucket array, independent of any
     * particular canvas's pixel width — the pad-tile canvas (~110px) and the
     * side-panel one (~260px) both scale the same cached result to fit, in
     * paintWaveform() below. Cached by filesystem_path, including a cached
     * `null` (a file the parser couldn't read) — the point of caching a null
     * is specifically to stop re-fetching/re-requesting it on every render,
     * since `refresh()` rebuilds the whole grid after every action. */

    function paintWaveform(canvas, peaks) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height, mid = h / 2;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#444';
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        if (!peaks || !peaks.length) return;
        ctx.fillStyle = '#9c9';
        // Map each pixel column to a peaks index by proportion, not 1:1 —
        // peaks.length (always 128) essentially never equals canvas.width,
        // so a naive index==pixel loop would squish/truncate the drawing.
        for (let x = 0; x < w; x++) {
            const p = peaks[Math.min(peaks.length - 1, Math.floor(x * peaks.length / w))];
            const y1 = mid - p.max * mid;
            const y2 = mid - p.min * mid;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
    }

    async function drawWaveform(canvas, filesystemPath) {
        if (waveformCache.has(filesystemPath)) {
            paintWaveform(canvas, waveformCache.get(filesystemPath));
            return;
        }

        paintWaveform(canvas, null);   // clear to the center-line placeholder while loading
        try {
            const res = await fetch('/kit-builder/PEAKS/' + encodeURIComponent(filesystemPath));
            const json = await res.json();
            const peaks = (json && json.ok) ? json.peaks : null;
            waveformCache.set(filesystemPath, peaks);
            // Every pad tile gets its own freshly-created <canvas> on each
            // render (renderGrid()/renderPadDetail() rebuild from scratch), so
            // a canvas that's no longer attached by the time the fetch
            // resolves means a newer render already replaced it — painting
            // into it would be invisible anyway, just skip the wasted work.
            if (!canvas.isConnected) return;
            paintWaveform(canvas, peaks);
        } catch (e) {
            /* network/parse failure — leave the center-line placeholder
             * rather than surfacing an error; this is a non-essential
             * visualisation. Deliberately NOT cached (unlike a server-
             * confirmed null), since this might just be a transient network
             * hiccup worth retrying on the next render. */
        }
    }

    /* ---- folder-picker modal (reuses nodeServer's /file-browser/LIST) --- */

    function openBrowser(title, target, startPath) {
        browserTarget = target;
        browserPath = startPath || '/media';
        document.getElementById('kb-browser-title').textContent = title;
        document.getElementById('kb-browser-select').classList.toggle('kb-hidden', target === 'xpm-file');
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
        if (!folders.length && browserTarget !== 'xpm-file') {
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

        if (browserTarget === 'xpm-file') {
            const files = (listing.FILES || []).filter((f) => /\.xpm$/i.test(f.name || ''));
            files.forEach((f) => {
                const li = document.createElement('li');
                li.textContent = '🥁 ' + f.name;
                li.addEventListener('click', () => importXpmFile(f.path));
                ul.appendChild(li);
            });
            if (!folders.length && !files.length) {
                const li = document.createElement('li');
                li.textContent = '(no .xpm files here)';
                li.style.cursor = 'default';
                ul.appendChild(li);
            }
        }
    }

    async function importXpmFile(xpmPath) {
        closeBrowser();
        try {
            const r = await api('IMPORT_XPM', { path: xpmPath });
            selectedPad = null;
            await refresh();
            const msg = 'Loaded ' + r.imported + ' pad(s)' + (r.warnings.length ? ' (' + r.warnings.length + ' warning(s))' : '');
            setStatus(msg, false);
        } catch (e) {
            setStatus(String(e.message || e), true);
        }
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

        document.getElementById('kb-load-xpm').addEventListener('click', () => openBrowser('Load an XPM kit', 'xpm-file', SUGGESTED_EXPORT_DIR));
        document.getElementById('kb-add-root').addEventListener('click', () => openBrowser('Add a sample folder', 'root'));
        document.getElementById('kb-choose-dest').addEventListener('click', () => openBrowser('Choose export destination', 'dest', SUGGESTED_EXPORT_DIR));
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
