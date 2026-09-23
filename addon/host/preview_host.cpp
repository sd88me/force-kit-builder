/*
 * Force Kit Builder — audible pad preview producer (v3, see DESIGN.md's
 * "v3 scoping" / "v3 revision: touchscreen trigger, not MIDI" for the full
 * design and why this is a separate native process from daemon.mjs).
 *
 * Flow: shadow_page.conf's per-pad PLAY button sends its SET through
 * daemon.mjs's existing control socket (shadow_page.conf only has one
 * ctrl_sock per page); daemon.mjs relays "PLAY <padIndex>" to *this*
 * process's own tiny listen socket (see run_play_server() below) rather
 * than owning the shared-memory ring itself (daemon.mjs is boot-launched
 * and always running - if it held the ring directly, every acvs restart
 * would happen while a voice was attached, exactly the state
 * force-audio-jack's own hard rule forbids). On PLAY, this process asks
 * daemon.mjs which WAV is on that pad (GET pad_path_<n>, a plain
 * filesystem path, not run through daemon.mjs's shadowFontSafe() display
 * sanitizer) -> decodes the WAV from scratch (no library, matching this
 * project's core/wav_info.mjs convention) -> resamples to 44100 if needed
 * -> pushes into /forceAudioInject<mix-slot>, the same shared-memory ring
 * Maze Voice/DX7/JV-880 already inject audio through.
 *
 * No MIDI at all — an earlier draft of this used a virtual RtMidiIn port
 * (the family's standard pattern for Maze Voice/DX7/etc.), but that means
 * a real separate ALSA MIDI destination the user has to route a track's
 * output to before anything works. Asked directly, not assumed: a
 * touchscreen PLAY button avoids that setup step entirely, at the cost of
 * only being triggerable from the shadow page itself (not from physically
 * playing a routed track's pads) - an accepted tradeoff, not an oversight.
 *
 * Playback is monophonic with cutoff-on-retrigger, and plays the whole
 * sample however long it is. The ring is only AI_RING_FRAMES (~1.5 s at
 * 44.1k), so instead of pushing a whole decoded sample in one go (which
 * used to truncate anything longer than that), a feeder thread streams the
 * current voice into the ring, keeping only FEED_LEAD_FRAMES queued ahead
 * of the consumer. A new PLAY just swaps the current voice under a mutex:
 * the old one gets a short fade-out appended and the new one follows, so
 * the cutoff happens within ~FEED_LEAD_FRAMES without ever touching
 * head/tail from the producer side except the normal append (resetting
 * the ring mid-read would be a real race with the consumer inside MPC).
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <vector>
#include <string>
#include <thread>
#include <chrono>
#include <memory>
#include <mutex>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "forceAudioInject.h"

/* ---- config (parsed from argv, see NSMODULE.json's ARGUMENTS) ------------ */

static std::string g_ctrl_sock = "/tmp/kitbuilder_ctrl.sock";
static std::string g_listen_sock = "/tmp/kitbuilder_preview_ctrl.sock";
static unsigned g_mix_slot = 3;

/* ---- shared-memory ring (producer side) — mirrors dx7_host.cpp's
 * shm_setup()/ring_push() exactly (same struct, same SPSC protocol,
 * same acquire/release ordering on head/tail). Not reinvented. --------- */

static ai_shm_t *g_shm = nullptr;
static char g_shm_name[24];

static bool shm_setup() {
    ai_shm_name(g_mix_slot, g_shm_name, sizeof(g_shm_name));
    shm_unlink(g_shm_name);
    int fd = shm_open(g_shm_name, O_CREAT | O_RDWR, 0666);
    if (fd < 0) { perror("shm_open"); return false; }
    if (ftruncate(fd, AI_SHM_BYTES) != 0) { perror("ftruncate"); close(fd); return false; }
    void *m = mmap(nullptr, AI_SHM_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (m == MAP_FAILED) { perror("mmap"); return false; }

    g_shm = (ai_shm_t *)m;
    memset(g_shm, 0, AI_SHM_BYTES);
    g_shm->rate = 44100;
    g_shm->channels = 2;
    g_shm->enabled = 1;
    g_shm->gain = 1.0f;   /* v1: fixed unity gain - see DESIGN.md's v3 scoping,
                            * per-pad playback.gain is a known v2 tie-in, not
                            * wired here yet. */
    g_shm->channel_mask = AI_CHAN_LR;
    __atomic_store_n(&g_shm->magic, AI_MAGIC, __ATOMIC_RELEASE);
    return true;
}

static void ring_push(const float *interleaved, uint32_t frames) {
    if (!g_shm) return;
    uint32_t head = g_shm->head;
    uint32_t tail = __atomic_load_n(&g_shm->tail, __ATOMIC_ACQUIRE);
    uint32_t space = (AI_RING_FRAMES - 1) - ((head - tail) & (AI_RING_FRAMES - 1));

    uint32_t take = frames;
    if (take > space) take = space;   /* ring full: drop the tail of this hit rather than block */
    for (uint32_t i = 0; i < take; i++) {
        uint32_t fr = (head + i) & (AI_RING_FRAMES - 1);
        float *dst = &g_shm->ring[(size_t)fr * AI_MAX_CH];
        dst[0] = interleaved[2 * i];
        dst[1] = interleaved[2 * i + 1];
    }
    __atomic_store_n(&g_shm->head, (head + take) & (AI_RING_FRAMES - 1), __ATOMIC_RELEASE);
    g_shm->frames_written += take;
}

/* ---- control-socket client: ask daemon.mjs which WAV is on a pad --------
 * Same plain-text protocol every shadow-GUI-backed addon uses (see
 * force-shadow/docs/adding-a-page.md): "GET <key>\n" -> "<value>\n" over
 * AF_UNIX/SOCK_STREAM. One short-lived connection per note-on - simple,
 * and note-on rate is nowhere near hot enough for connection setup cost
 * to matter. */

static std::string ctrl_get_pad_path(int padIndex) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return "";

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, g_ctrl_sock.c_str(), sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { close(fd); return ""; }

    char req[64];
    int reqLen = snprintf(req, sizeof(req), "GET pad_path_%d\n", padIndex);
    if (reqLen <= 0 || write(fd, req, (size_t)reqLen) < 0) { close(fd); return ""; }

    char buf[1024] = { 0 };
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return "";

    std::string s(buf, (size_t)n);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    return s;
}

/* ---- WAV decode: from-scratch RIFF/WAVE parser --------------------------
 *
 * Mirrors core/wav_info.mjs's edge-case handling (odd-chunk word-align
 * padding, a chunk claiming more bytes than the file actually has, no data
 * chunk at all) in the same spirit, ported to C++ since there's no existing
 * WAV-reading precedent in this native host family to reuse (dx7_host.cpp/
 * maze_host.cpp are pure synthesis, no sample playback). Supports 8/16/24/
 * 32-bit PCM and 32-bit IEEE float, mono or stereo; mono is duplicated to
 * both output channels. Anything else (>2 channels, compressed formats)
 * is rejected, matching core/wav_peaks.mjs's own "unsupported format ->
 * null" convention rather than guessing.
 */

struct WavDecoded {
    std::vector<float> interleaved_stereo;   /* always 2ch, L,R,L,R,... */
    uint32_t frames = 0;
    uint32_t rate = 0;
};

static uint32_t rd_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint16_t rd_u16le(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

static bool decode_wav_file(const std::string &path, WavDecoded &out) {
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return false;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz <= 44) { fclose(f); return false; }
    fseek(f, 0, SEEK_SET);

    std::vector<uint8_t> buf((size_t)sz);
    size_t rd = fread(buf.data(), 1, (size_t)sz, f);
    fclose(f);
    if (rd != (size_t)sz) return false;

    if (memcmp(&buf[0], "RIFF", 4) != 0 || memcmp(&buf[8], "WAVE", 4) != 0) return false;

    uint16_t audioFormat = 0, numChannels = 0, bitsPerSample = 0;
    uint32_t sampleRate = 0;
    const uint8_t *dataPtr = nullptr;
    uint32_t dataBytes = 0;

    size_t pos = 12;
    while (pos + 8 <= (size_t)sz) {
        uint32_t chunkSize = rd_u32le(&buf[pos + 4]);
        size_t body = pos + 8;
        if (body + chunkSize > (size_t)sz) chunkSize = (uint32_t)((size_t)sz - body);   /* truncated file */

        if (memcmp(&buf[pos], "fmt ", 4) == 0 && chunkSize >= 16) {
            audioFormat = rd_u16le(&buf[body]);
            numChannels = rd_u16le(&buf[body + 2]);
            sampleRate = rd_u32le(&buf[body + 4]);
            bitsPerSample = rd_u16le(&buf[body + 14]);
        } else if (memcmp(&buf[pos], "data", 4) == 0) {
            dataPtr = &buf[body];
            dataBytes = chunkSize;
        }
        pos = body + chunkSize + (chunkSize & 1);   /* word-align pad */
    }

    if (!dataPtr || !dataBytes || numChannels == 0 || numChannels > 2 || bitsPerSample == 0) return false;

    int bytesPerSample = bitsPerSample / 8;
    if (bytesPerSample == 0) return false;
    uint32_t frameBytes = (uint32_t)bytesPerSample * numChannels;
    uint32_t frames = dataBytes / frameBytes;
    if (!frames) return false;

    out.frames = frames;
    out.rate = sampleRate ? sampleRate : 44100;
    out.interleaved_stereo.assign((size_t)frames * 2, 0.0f);

    for (uint32_t i = 0; i < frames; i++) {
        float chVal[2] = { 0.0f, 0.0f };
        for (int ch = 0; ch < numChannels; ch++) {
            const uint8_t *sp = dataPtr + (size_t)i * frameBytes + (size_t)ch * bytesPerSample;
            float v = 0.0f;
            if (audioFormat == 3 && bitsPerSample == 32) {          /* IEEE float */
                uint32_t bits = rd_u32le(sp);
                memcpy(&v, &bits, 4);
            } else if (audioFormat == 1) {                          /* PCM */
                if (bitsPerSample == 8) {
                    v = ((int)sp[0] - 128) / 128.0f;                /* unsigned 8-bit */
                } else if (bitsPerSample == 16) {
                    int16_t s = (int16_t)rd_u16le(sp);
                    v = s / 32768.0f;
                } else if (bitsPerSample == 24) {
                    int32_t s = (int32_t)sp[0] | ((int32_t)sp[1] << 8) | ((int32_t)sp[2] << 16);
                    if (s & 0x800000) s |= (int32_t)0xFF000000;     /* sign-extend 24->32 */
                    v = s / 8388608.0f;
                } else if (bitsPerSample == 32) {
                    int32_t s = (int32_t)rd_u32le(sp);
                    v = s / 2147483648.0f;
                }
            }
            chVal[ch] = v;
        }
        float L = chVal[0];
        float R = (numChannels == 2) ? chVal[1] : chVal[0];
        out.interleaved_stereo[(size_t)i * 2 + 0] = L;
        out.interleaved_stereo[(size_t)i * 2 + 1] = R;
    }
    return true;
}

/* ---- linear resampler: WAV's own rate -> the ring's fixed declared 44100.
 * Good enough for a percussion one-shot preview (not archival quality);
 * revisit only if a real sample library at a very different rate makes
 * that audible. ------------------------------------------------------- */

static std::vector<float> resample_to_44100(const std::vector<float> &src, uint32_t frames, uint32_t srcRate) {
    if (srcRate == 44100 || frames == 0) return src;
    double ratio = 44100.0 / (double)srcRate;
    uint32_t outFrames = (uint32_t)((double)frames * ratio);
    std::vector<float> out((size_t)outFrames * 2, 0.0f);
    for (uint32_t i = 0; i < outFrames; i++) {
        double srcPos = (double)i / ratio;
        uint32_t i0 = (uint32_t)srcPos;
        uint32_t i1 = (i0 + 1 < frames) ? i0 + 1 : i0;
        float frac = (float)(srcPos - i0);
        for (int ch = 0; ch < 2; ch++) {
            float a = src[(size_t)i0 * 2 + ch], b = src[(size_t)i1 * 2 + ch];
            out[(size_t)i * 2 + ch] = a + (b - a) * frac;
        }
    }
    return out;
}

/* ---- streaming voice: one sample at a time, fed into the ring by
 * feeder_thread() a little ahead of the consumer ---------------------- */

static const uint32_t FEED_LEAD_FRAMES = 2048;   /* ~46 ms queued ahead = max retrigger latency */
static const uint32_t FADE_FRAMES = 128;         /* ~3 ms fade on cutoff, avoids a click */

struct Voice {
    std::vector<float> data;   /* interleaved stereo @ 44100 */
    uint32_t frames = 0;
    uint32_t pos = 0;
};

static std::mutex g_voice_mu;
static std::unique_ptr<Voice> g_voice;
static std::unique_ptr<Voice> g_pending;

static void start_voice(std::vector<float> &&data) {
    std::unique_ptr<Voice> v(new Voice);
    v->frames = (uint32_t)(data.size() / 2);
    v->data = std::move(data);
    std::lock_guard<std::mutex> lk(g_voice_mu);
    g_pending = std::move(v);
}

static uint32_t ring_queued() {
    uint32_t head = g_shm->head;
    uint32_t tail = __atomic_load_n(&g_shm->tail, __ATOMIC_ACQUIRE);
    return (head - tail) & (AI_RING_FRAMES - 1);
}

static void feeder_step() {
    if (!g_shm) return;
    std::lock_guard<std::mutex> lk(g_voice_mu);

    if (g_pending) {
        /* cutoff: fade out whatever is left of the old voice, then switch */
        if (g_voice && g_voice->pos < g_voice->frames) {
            uint32_t n = g_voice->frames - g_voice->pos;
            if (n > FADE_FRAMES) n = FADE_FRAMES;
            float fade[FADE_FRAMES * 2];
            const float *src = &g_voice->data[(size_t)g_voice->pos * 2];
            for (uint32_t i = 0; i < n; i++) {
                float g = 1.0f - (float)(i + 1) / (float)n;
                fade[2 * i] = src[2 * i] * g;
                fade[2 * i + 1] = src[2 * i + 1] * g;
            }
            ring_push(fade, n);
        }
        g_voice = std::move(g_pending);
    }

    if (!g_voice || g_voice->pos >= g_voice->frames) return;
    uint32_t queued = ring_queued();
    if (queued >= FEED_LEAD_FRAMES) return;
    uint32_t n = FEED_LEAD_FRAMES - queued;
    uint32_t left = g_voice->frames - g_voice->pos;
    if (n > left) n = left;
    ring_push(&g_voice->data[(size_t)g_voice->pos * 2], n);
    g_voice->pos += n;
}

static void feeder_thread() {
    while (true) {
        feeder_step();
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}

/* ---- play one pad: shared by the real listen server and --test-full ----- */

struct PlayResult { bool ok; std::string msg; };

static PlayResult play_pad(int padIndex) {
    if (padIndex < 0 || padIndex > 15) return { false, "bad pad index" };

    std::string path = ctrl_get_pad_path(padIndex);
    if (path.empty()) return { false, "empty pad" };

    WavDecoded w;
    if (!decode_wav_file(path, w)) return { false, "decode failed" };

    std::vector<float> resampled = resample_to_44100(w.interleaved_stereo, w.frames, w.rate);
    uint32_t outFrames = (uint32_t)(resampled.size() / 2);

    start_voice(std::move(resampled));
    fprintf(stderr, "[kb-preview] pad %d -> %s (%u frames)\n", padIndex + 1, path.c_str(), outFrames);
    return { true, "" };
}

/* ---- listen socket: daemon.mjs relays "PLAY <padIndex>\n" here from the
 * shadow page's PLAY button (see shadow_page.conf / daemon.mjs's play_pad_N
 * handler). Same plain-text style as every other control socket in this
 * family, just a different (smaller) verb set - this isn't the shadow-GUI
 * ctrl_sock protocol itself, daemon.mjs still owns that. ------------------- */

static void run_play_server() {
    unlink(g_listen_sock.c_str());
    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    if (srv < 0) { perror("socket"); return; }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, g_listen_sock.c_str(), sizeof(addr.sun_path) - 1);

    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) { perror("bind"); close(srv); return; }
    chmod(g_listen_sock.c_str(), 0777);
    if (listen(srv, 8) != 0) { perror("listen"); close(srv); return; }

    fprintf(stderr, "[kb-preview] ready - ring slot %u, listening on %s\n", g_mix_slot, g_listen_sock.c_str());

    while (true) {
        int cfd = accept(srv, nullptr, nullptr);
        if (cfd < 0) continue;

        char buf[256] = { 0 };
        ssize_t n = read(cfd, buf, sizeof(buf) - 1);
        if (n > 0) {
            std::string line(buf, (size_t)n);
            while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();

            if (line.rfind("PLAY ", 0) == 0) {
                int padIndex = atoi(line.c_str() + 5);
                PlayResult r = play_pad(padIndex);
                std::string reply = (r.ok ? "OK\n" : ("ERR " + r.msg + "\n"));
                write(cfd, reply.c_str(), reply.size());
            } else {
                const char *err = "ERR unknown command\n";
                write(cfd, err, strlen(err));
            }
        }
        close(cfd);
    }
}

/* ---- offline self-test: --test-decode <wav-path> --------------------
 * Exercises decode_wav_file()/resample_to_44100() without touching MIDI,
 * shared memory, or the control socket - none of which are realistically
 * testable in this build environment (no ALSA sequencer, no real device).
 * Prints frames/rate/first few samples so a small script can compare
 * against known-good values across every format the decoder claims to
 * support - see DESIGN.md's v3 "Open items": WAV decode coverage. */
static int run_test_decode(const char *path) {
    WavDecoded w;
    if (!decode_wav_file(path, w)) {
        printf("DECODE_FAILED\n");
        return 1;
    }
    printf("frames=%u rate=%u\n", w.frames, w.rate);
    uint32_t n = w.frames < 5 ? w.frames : 5;
    for (uint32_t i = 0; i < n; i++) {
        printf("sample[%u]=%.6f,%.6f\n", i, w.interleaved_stereo[i * 2], w.interleaved_stereo[i * 2 + 1]);
    }
    std::vector<float> rs = resample_to_44100(w.interleaved_stereo, w.frames, w.rate);
    printf("resampled_frames=%u\n", (uint32_t)(rs.size() / 2));
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 3 && !strcmp(argv[1], "--test-decode")) {
        return run_test_decode(argv[2]);
    }
    if (argc >= 4 && !strcmp(argv[1], "--test-ctrl")) {
        g_ctrl_sock = argv[2];
        std::string path = ctrl_get_pad_path(atoi(argv[3]));
        printf("pad_path=%s\n", path.c_str());
        return path.empty() ? 1 : 0;
    }
    if (argc >= 5 && !strcmp(argv[1], "--test-full")) {
        /* Full pipeline minus the actual "tap the PLAY button" trigger:
         * ctrl lookup -> decode -> resample -> real shm ring write.
         * Exercises exactly what play_pad() does, just called directly
         * instead of from the listen socket - see the module doc for why
         * the real socket round trip from a live shadow page isn't
         * testable in this build environment. */
        g_ctrl_sock = argv[2];
        g_mix_slot = (unsigned)atoi(argv[3]);
        int padIndex = atoi(argv[4]);
        if (!shm_setup()) { printf("SHM_SETUP_FAILED\n"); return 1; }
        PlayResult r = play_pad(padIndex);
        if (!r.ok) { printf("PLAY_FAILED: %s\n", r.msg.c_str()); return 1; }
        feeder_step();   /* no consumer here: just the first FEED_LEAD_FRAMES */
        printf("ring_head=%u ring_frames_written=%llu\n",
               g_shm->head, (unsigned long long)g_shm->frames_written);
        return 0;
    }

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--ctrl-sock") && i + 1 < argc) g_ctrl_sock = argv[++i];
        else if (!strcmp(argv[i], "--listen-sock") && i + 1 < argc) g_listen_sock = argv[++i];
        else if (!strcmp(argv[i], "--mix-slot") && i + 1 < argc) g_mix_slot = (unsigned)atoi(argv[++i]);
    }

    if (!shm_setup()) {
        fprintf(stderr, "[kb-preview] shared memory setup failed\n");
        return 1;
    }

    std::thread(feeder_thread).detach();
    run_play_server();   /* blocks forever, accepting PLAY <n> connections */
    return 0;
}
