/*
 * Folder-role classification.
 */
import { assert, eq } from './assert.js';
import {
    normalizeToken, buildAliasIndex, classify, tokenizeFilename, classifyFilename
} from '../core/sample_classifier.mjs';
import { DEFAULT_CONFIG } from '../core/sample_index.mjs';

const idx = buildAliasIndex(DEFAULT_CONFIG.role_rules);
const role = (parts) => classify(parts, idx);
const fname = (n) => classifyFilename(n, idx);

export const tests = [
    { name: 'normalizeToken strips case and separators', fn() {
        eq(normalizeToken(' Open-Hat '), 'openhat');
        eq(normalizeToken('OPEN_HIHAT'), 'openhihat');
        eq(normalizeToken('Bass Drum'), 'bassdrum');
    }},

    { name: 'plain category folders', fn() {
        eq(role(['Kick']), 'kick');
        eq(role(['Snare']), 'snare');
        eq(role(['Clap']), 'clap');
        eq(role(['Percussion']), 'percussion');
        eq(role(['FX']), 'fx');
    }},

    { name: 'aliases across case and separators all hit open_hat', fn() {
        eq(role(['Open Hat']), 'open_hat');
        eq(role(['open_hats']), 'open_hat');
        eq(role(['Drums', 'Open-Hat']), 'open_hat');
        eq(role(['OPEN_HIHAT']), 'open_hat');
        eq(role(['oh']), 'open_hat');
    }},

    { name: 'closed hat aliases', fn() {
        eq(role(['Closed Hat']), 'closed_hat');
        eq(role(['closedhihat']), 'closed_hat');
        eq(role(['ch']), 'closed_hat');
    }},

    { name: 'kick aliases bd / bass drum', fn() {
        eq(role(['BD']), 'kick');
        eq(role(['Bass Drum']), 'kick');
    }},

    { name: 'full category vocabulary', fn() {
        eq(role(['Kck']), 'kick');
        eq(role(['Rimshot']), 'rim');
        eq(role(['Side Stick']), 'rim');
        eq(role(['Hand Clap']), 'clap');
        eq(role(['CP']), 'clap');
        eq(role(['Toms']), 'tom');
        eq(role(['Floor']), 'tom');
        eq(role(['Congas']), 'conga');
        eq(role(['Crash']), 'crash');
        eq(role(['Rides']), 'ride');
        eq(role(['Cymbals']), 'cymbal');
        eq(role(['Tambourine']), 'percussion');
        eq(role(['Cowbells']), 'percussion');
        eq(role(['Hits']), 'fx');
        eq(role(['Riser']), 'fx');
    }},

    { name: 'glitch category: its own folder alias, filename fallback, and fx unaffected by the split', fn() {
        eq(role(['Glitch']), 'glitch');
        eq(role(['Granular']), 'glitch');
        eq(fname('Granular_Texture_03.wav'), 'glitch');
        eq(fname('glitchy_stutter.wav'), 'glitch');
        eq(fname('grain_cloud_01.wav'), 'glitch');
        // fx keeps its remaining aliases after 'glitch'/'glitches' moved off it
        eq(role(['FX']), 'fx');
        eq(fname('riser_up.wav'), 'fx');
    }},

    { name: 'generic hat vs closed/open, plurals', fn() {
        eq(role(['Hi-Hats']), 'hat');           // generic -> its own `hat` category
        eq(role(['Hats']), 'hat');
        eq(role(['Closed Hats']), 'closed_hat');
        eq(role(['Open Hats']), 'open_hat');
        eq(role(['OHH']), 'open_hat');
        eq(role(['CHH']), 'closed_hat');
        // deepest wins: generic then specific
        eq(role(['Hi-Hats', 'Open Hats']), 'open_hat');
        eq(role(['Hats', 'Closed']), 'hat');    // 'closed' alone is not an alias
    }},

    { name: 'melodic categories (pool into Other for assignment)', fn() {
        eq(role(['Vocals']), 'vox');
        eq(role(['Choir']), 'vox');
        eq(role(['Bass']), 'bass');
        eq(role(['Sub']), 'bass');
        eq(role(['Synth']), 'synth');
        eq(role(['Analog']), 'synth');
        eq(role(['Chords']), 'chord');
        eq(role(['Stabs']), 'stab');
        eq(role(['Lead']), 'lead');
        eq(role(['Melodic']), 'lead');
        eq(role(['Pads']), 'pad');
        eq(role(['Keys']), 'pad');
        eq(role(['Piano']), 'pad');
    }},

    { name: 'shaker resolves to hat (listed under both hat and percussion)', fn() {
        eq(role(['Shakers']), 'hat');           // hat comes first in role_rules order
        eq(role(['Percussion', 'Shakers']), 'hat');   // deepest wins, still hat
    }},

    { name: 'deepest matching component wins', fn() {
        eq(role(['Percussion', 'Closed Hat']), 'closed_hat');
        eq(role(['Kicks', 'Layered', 'Snare']), 'snare');
        eq(role(['Open Hat', 'Kick']), 'kick');
    }},

    { name: 'unrecognised folders fall through to other', fn() {
        eq(role(['Unsorted']), 'other');
        eq(role([]), 'other');
        eq(role(['Weird', 'Nested', 'Thing']), 'other');
    }},

    { name: 'a nested subfolder under a recognised category keeps that category, not other', fn() {
        eq(role(['Kick', 'Vinyl']), 'kick');
    }},

    { name: 'tokenizeFilename splits separators, camelCase, letter/digit', fn() {
        eq(tokenizeFilename('Deep_Kick_01.wav'), ['deep', 'kick', '01']);
        eq(tokenizeFilename('OpenHat07.aif'), ['open', 'hat', '07']);
        eq(tokenizeFilename('808-boom.wav'), ['808', 'boom']);
        eq(tokenizeFilename('/a/b/CLSNAkd12.WAV'), ['clsnakd', '12']);
    }},

    { name: 'classifyFilename: token-exact keyword match, longest window first', fn() {
        eq(fname('punchy_kick_01.wav'), 'kick');
        eq(fname('open_hat_loop_120.wav'), 'open_hat');   // "open hat" beats bare "hat"
        eq(fname('closed_hh_01.wav'), 'closed_hat');
        eq(fname('chh_2.wav'), 'closed_hat');
        eq(fname('RideCymbal.wav'), 'ride');              // first hit (ride) wins
        eq(fname('sub_bass_c.wav'), 'bass');
        eq(fname('vox_chop.wav'), 'vox');
    }},

    { name: 'classifyFilename: no substring false positives', fn() {
        eq(fname('bassline_riff.wav'), 'other');   // "bassline" != "bass"
        eq(fname('kickstart.wav'), 'other');        // "kickstart" != "kick"
        eq(fname('whatever_99.wav'), 'other');
    }},

    { name: 'classify: folder wins; filename only rescues an "other" folder', fn() {
        eq(classify(['Kicks'], idx, 'snare_layer.wav'), 'kick');
        eq(classify(['Percussion'], idx, 'kick_thump.wav'), 'percussion');
        eq(classify(['One Shots'], idx, 'punchy_kick_01.wav'), 'kick');
        eq(classify(['Unsorted', 'Bits'], idx, 'clap_fat.wav'), 'clap');
        eq(classify(['One Shots'], idx, 'mystery_99.wav'), 'other');
        eq(classify(['One Shots'], idx), 'other');
    }},

    { name: 'classify: a generic "hat" folder is refined by the filename', fn() {
        eq(classify(['Hihat'], idx, 'Hihat Closed DM Accent.wav'), 'closed_hat');
        eq(classify(['Hihat'], idx, 'Hihat Open 707.aif'), 'open_hat');
        eq(classify(['Drums', 'Hats'], idx, 'CH_808.wav'), 'closed_hat');
        eq(classify(['Hi-Hats'], idx, 'OH vinyl 3.wav'), 'open_hat');
        eq(classify(['Hihat'], idx, 'Hihat Vinyl 3.wav'), 'hat');
        eq(classify(['Closed Hats'], idx, 'something open.wav'), 'closed_hat');
    }},
];
