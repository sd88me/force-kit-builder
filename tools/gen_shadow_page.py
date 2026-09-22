#!/usr/bin/env python3
# Generates addon/shadow_page.conf - readout/toggle/button/knob/stepper
# widgets take cx/cy (center point), not x/y (top-left); frame/list take
# x/y (top-left). Confirmed against force-shadow/src/force_shadow.c's real
# parser, not just the preview tool. Doing this by hand for 16 pads is
# exactly how the first draft got it wrong.
#
# v4 (2026-09-22): two pages based on hand-drawn sketches, superseding the
# earlier four-tab design - see DESIGN.md's "v4" section for that history.
#
# v4.1 (2026-09-23), after live-device testing surfaced real bugs no
# offline render caught:
#
# - MAX_FRAMES is 6 per tab (force_shadow.c), a SEPARATE cap from the
#   64-widget MAX_WIDGETS one - frames don't count against MAX_WIDGETS,
#   but they have their own budget, silently dropped past 6
#   (`if (n_page_frames >= MAX_FRAMES) return;`, no error, no log). The
#   original 16-pad-one-page PADS design had 16 frames; only the first 6
#   rendered on real hardware. PADS is now split into three pages of up
#   to 6 pads each (PADS 1-6 / 7-12 / 13-16), each safely under the cap.
# - The real per-character text-advance at scale 1.5 is a BAKED CONSTANT,
#   FONT_HI_1_5_W = 10 (src/font_hi.h), not the preview tool's own
#   approximation (`(GLYPH_CELL+1)*scale-scale` = ~15/char) - the two
#   tools disagree by ~50%. Every width calculation below now uses the
#   real formula (see text_width_1_5() here) confirmed by reading
#   force_shadow.c's text_width_land()/text_advance() directly, not the
#   preview tool's approximation that produced misleadingly-safe-looking
#   numbers in the v4 pass.
# - Frame content starts below the title+divider zone at f->y+38
#   (render_frame_box's td3 branch) - a widget whose top edge lands above
#   that (cy - half_height < y+38) overlaps the frame's own title text,
#   not just looks close to it. Verified this was happening to DETAIL's
#   pad-selector row before this revision.
CATEGORIES = [
    ('kick', 'KICK'), ('snare', 'SNARE'), ('rim', 'RIM'), ('clap', 'CLAP'),
    ('hat', 'HAT'), ('closed_hat', 'CLOSED HAT'), ('open_hat', 'OPEN HAT'),
    ('tom', 'TOM'), ('conga', 'CONGA'), ('percussion', 'PERC'),
    ('crash', 'CRASH'), ('ride', 'RIDE'), ('cymbal', 'CYMBAL'), ('fx', 'FX'),
    ('glitch', 'GLITCH'), ('vox', 'VOX'), ('bass', 'BASS'), ('synth', 'SYNTH'),
    ('stab', 'STAB'), ('chord', 'CHORD'), ('lead', 'LEAD'), ('pad', 'PAD'),
    ('other', 'OTHER'),
]

HEADER = '''# ForceKitBuilder — shadow-GUI page (v4.1: four pages - PADS 1-6 / 7-12 /
# 13-16 performance grids + DETAIL single-pad view). See DESIGN.md's "v4"
# and "v4.1" sections for the full redesign history and the real bugs
# live-device testing caught that no offline render could (MAX_FRAMES=6
# per tab, the preview tool's inaccurate font-width approximation).
#
# page=8, not 1-7: only seven SHIFT+SCENE-N combos physically exist, and
# on the real device all seven were already taken (DX7, JV-880, Maze
# Voice, Maze Seq, Acid, Euclidier, plus force-shadow's own launcher at
# slot 7). Kit Builder is exactly the "low-frequency tool" case
# docs/adding-a-page.md's "Add-on launcher (tool add-ons)" section
# describes - page 8+ isn't combo-bound, it's reached via the launcher
# page (SHIFT+SCENE-7) instead.
#
# Colour scheme: an approximation of the Akai Force's own OS look (dark
# charcoal chassis, orange selection/accent, neutral grey buttons) - no
# verified reference screenshot or hex values for the real Force OS
# exist in this repo family yet. Keeps style=td3's proven widget shapes
# (rounded frames, pill buttons), only the theme_* colour values are
# overridden.
#
# IMPORTANT widget coordinate rule (confirmed against
# force-shadow/src/force_shadow.c's real conf parser, not just the
# preview tool): frame and list take x=/y= (top-left corner). Every
# other widget kind - readout, toggle, button, knob, stepper, enum_h/v -
# takes cx=/cy= (CENTER point).
#
# Two SEPARATE per-tab caps, confirmed in force_shadow.c, not guessed:
# MAX_WIDGETS=64 (non-frame widgets - `if (strcmp(type,"frame")!=0 &&
# n_page_widgets>=MAX_WIDGETS) return;`) and MAX_FRAMES=6 (`if
# (n_page_frames>=MAX_FRAMES) return;`). Both fail silently, no error, no
# log - past either limit, that widget/frame simply never gets stored.
# The preview tool's own line-storage buffer (64 *lines* per tab
# including frames) is a THIRD, tooling-only limit that doesn't match
# either real cap - don't use it as a proxy for MAX_FRAMES.
#
# Button widgets have a FIXED height in this format (48px, td3-style) -
# width grows with label text but there is no w=/h= override for buttons
# in the real conf parser, so a literal bigger *square* button isn't
# achievable. A knob was considered as a tap-to-play alternative and
# ruled out: W_KNOB only arms a drag on touch-down, nothing fires on a
# plain tap (force_shadow.c's touch handler).
#
# Real per-character text advance at scale 1.5 is a baked constant, 10px
# (src/font_hi.h's FONT_HI_1_5_W) - NOT the preview tool's own
# approximation, which overstates width by ~50% (see text_width_1_5()
# in tools/gen_shadow_page.py). Button width = chars*10 + 36 + 24 (td3).
#
# Generated by tools/gen_shadow_page.py (force-kit-builder repo) - edit
# that script and regenerate rather than hand-editing this file.
page=8
ctrl_sock=/tmp/kitbuilder_ctrl.sock
display_name="KIT BUILDER"

style=td3
theme_bg=1a1a1a
theme_panel=1a1a1a
theme_line=2e2e2e
theme_ink=f2f2f2
theme_ink_dim=aaaaaa
theme_ink_faint=666666
theme_accent=ff8f00
theme_accent_hi=ffb74d
theme_knob_face=2a2a2a
theme_knob_ring=000000
theme_bar=2a2a2a
theme_seg_active=ff8f00
theme_seg_inactive=2a2a2a
theme_seg_active_tx=000000
theme_btn_text=ffffff
theme_well=000000
theme_knob_off=444444
theme_tab_on=2a2a2a
theme_lcd=000000
theme_box=202020
theme_btn_bg=3a3a3c
theme_chrome_ink=ffffff
theme_go_on=00e676
theme_go_off=616161
theme_tabs=1a1a1a
'''

ACCENT_HEX = 'ff8f00'   # same hex as theme_accent - button color= override

TOPBAR_LASTPLAYED = 'readout cx=840 cy=36 w=780 h=48 label="" get=status'

FRAME_TITLE_DIVIDER_Y = 38   # render_frame_box's td3 branch: divider at f->y+38
FRAME_CONTENT_TOP_MARGIN = 12   # minimum clearance below the divider


def text_width_1_5(s):
    """Real button/label width at scale 1.5 - force_shadow.c's
    text_width_land(s,1.5) = strlen(s) * FONT_HI_1_5_W (=10), a baked
    constant, NOT the preview tool's `(GLYPH_CELL+1)*scale-scale`
    approximation (~15/char) which overstates width by ~50%."""
    return len(s) * 10


def button_width(label):
    return text_width_1_5(label) + 36 + 24   # +24 only applies in td3, which this page always uses


# ---- PADS pages: up to 6 pads each, 3 cols x 2 rows -----------------------
# MAX_FRAMES=6 per tab (see HEADER) forces splitting 16 pads across three
# pages instead of one - 6+6+4. Each pad now gets a bigger cell (was
# 295x150 in the single-page design), enough room to bring CLEAR back:
# widget count is no longer the binding constraint for 6 pads (6*4+1=25,
# far under MAX_WIDGETS=64) the way it was for 16 pads on one page.
PADS_PER_PAGE = 6
PADS_COLS, PADS_ROWS = 3, 2
PADS_CELL_W, PADS_CELL_H = 400, 313
PADS_GAP_X, PADS_GAP_Y = 20, 20
PADS_X0, PADS_Y0 = 20, 82


def pads_cell(pad_num, pad_index, x, y):
    # Left column = PLAY (big, spans most of the cell's height). Right
    # column = LOCK/REROLL/CLEAR stacked - three rows fit comfortably now
    # that cells are much taller (313px vs the old single-page design's
    # 150px). Content must start below the frame's title/divider
    # (y+38+margin) - checked explicitly, not assumed, after DETAIL's
    # pad-selector row was found overlapping its own frame's title.
    content_top = y + FRAME_TITLE_DIVIDER_Y + FRAME_CONTENT_TOP_MARGIN
    content_bottom = y + PADS_CELL_H - 16
    left_cx = x + PADS_CELL_W // 4
    right_cx = x + (PADS_CELL_W * 3) // 4
    play_cy = (content_top + content_bottom) // 2
    row_h = (content_bottom - content_top) // 3
    lock_cy = content_top + row_h // 2
    reroll_cy = content_top + row_h + row_h // 2
    clear_cy = content_top + 2 * row_h + row_h // 2
    return '\n'.join([
        f'frame   x={x} y={y} w={PADS_CELL_W} h={PADS_CELL_H} title="PAD {pad_num}"',
        f'button  cx={left_cx} cy={play_cy} label="PLAY" key=play_pad_{pad_index} color={ACCENT_HEX}',
        f'toggle  cx={right_cx} cy={lock_cy} label="LOCK" key=pad_lock_{pad_index}',
        f'button  cx={right_cx} cy={reroll_cy} label="REROLL" key=reroll_pad_{pad_index}',
        f'button  cx={right_cx} cy={clear_cy} label="CLEAR" key=clear_pad_{pad_index}',
    ])


def pads_page(tab_name, pad_indices):
    assert len(pad_indices) <= PADS_PER_PAGE, f'{tab_name}: {len(pad_indices)} pads exceeds MAX_FRAMES={PADS_PER_PAGE}'
    lines = [f'[tab {tab_name}]', TOPBAR_LASTPLAYED, '']
    for slot, pad_index in enumerate(pad_indices):
        col, row = slot % PADS_COLS, slot // PADS_COLS
        x = PADS_X0 + col * (PADS_CELL_W + PADS_GAP_X)
        y = PADS_Y0 + row * (PADS_CELL_H + PADS_GAP_Y)
        lines.append(pads_cell(pad_index + 1, pad_index, x, y))
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


# ---- DETAIL page ------------------------------------------------------------
# Top-left: category toggle matrix. Top-right: global actions, vertical
# stack. Bottom: full-width pad detail bar. Only 3 frames on this whole
# page (CATEGORY, KIT, PAD DETAIL) - nowhere near MAX_FRAMES=6.
CAT_FRAME = (20, 82, 860, 380)
GLOBAL_COL = (900, 82, 340, 380)
DETAIL_BAR = (20, 482, 1240, 246)
CAT_COLS, CAT_ROWS = 6, 4


def detail_tab():
    cfx, cfy, cfw, cfh = CAT_FRAME
    gx, gy, gw, gh = GLOBAL_COL
    dbx, dby, dbw, dbh = DETAIL_BAR
    gcx = gx + gw // 2

    lines = [
        '[tab DETAIL]',
        f'frame   x={cfx} y={cfy} w={cfw} h={cfh} title="CATEGORY - TAP TO TOGGLE"',
    ]

    interior_x0, interior_x1 = cfx + 16, cfx + cfw - 16
    interior_y0, interior_y1 = cfy + 40, cfy + cfh - 16
    col_step = (interior_x1 - interior_x0) / CAT_COLS
    row_step = (interior_y1 - interior_y0) / CAT_ROWS
    for i, (cat, label) in enumerate(CATEGORIES):
        col, row = i % CAT_COLS, i // CAT_COLS
        cx = int(interior_x0 + col_step * col + col_step / 2)
        cy = int(interior_y0 + row_step * row + row_step / 2)
        lines.append(f'toggle  cx={cx} cy={cy} label="{label}" key=detail_cat_{cat}')

    # Vertical global-action stack, far right. Widened from the v4 pass's
    # 300px to 340px, and button rows re-spaced within the shorter frame
    # (380px, was 406) - EXPORT KIT's bottom edge was only ~2px from the
    # frame's own bottom border in the previous layout (checked with the
    # real button-height formula, 48px td3 fixed height, not assumed).
    content_top = gy + FRAME_TITLE_DIVIDER_Y + FRAME_CONTENT_TOP_MARGIN
    content_bottom = gy + gh - 16
    btn_row_h = (content_bottom - content_top) // 4
    btn_ys = [content_top + btn_row_h * i + btn_row_h // 2 for i in range(4)]
    lines += [
        f'frame   x={gx} y={gy} w={gw} h={gh} title="KIT"',
        f'button  cx={gcx} cy={btn_ys[0]} label="GENERATE ALL" key=generate',
        f'button  cx={gcx} cy={btn_ys[1]} label="CLEAR ALL" key=clear_all',
        f'button  cx={gcx} cy={btn_ys[2]} label="NORMALISE" key=normalize',
        f'button  cx={gcx} cy={btn_ys[3]} label="EXPORT KIT" key=export',
    ]
    for label, cy in zip(['GENERATE ALL', 'CLEAR ALL', 'NORMALISE', 'EXPORT KIT'], btn_ys):
        bw = button_width(label)
        assert gx + 16 <= gcx - bw // 2 and gcx + bw // 2 <= gx + gw - 16, \
            f'KIT button "{label}" (w={bw}) overflows GLOBAL_COL at cy={cy}'

    # Full-width detail bar. Gain knob sits directly under the pad stepper
    # (not beside the readout) so the sample-name readout gets the freed
    # width. Row1 (stepper/readout/PLAY) must clear the frame's own
    # title/divider (y+38) - a previous draft's stepper overlapped it
    # (top edge above y+38, confirmed by the same math used here).
    # Row2 (LOCK/CLEAR/REROLL) shares GAIN's centreline per feedback, but
    # GAIN's own label+value text extends to cy+radius+42 (checked via
    # force_shadow.c's real W_KNOB draw offsets: label at cy+r+12, value
    # at cy+r+29, plus ~13px glyph height) - the frame must be tall enough
    # for THAT, not just the knob's circle.
    nav_cx = dbx + 130
    stepper_h = 44
    stepper_cy = dby + FRAME_TITLE_DIVIDER_Y + FRAME_CONTENT_TOP_MARGIN + stepper_h // 2
    knob_r = 35
    knob_text_bottom_offset = knob_r + 42   # label (r+12) + value (r+29) + ~13px glyph height, from knob cy
    knob_cy = dby + dbh - knob_text_bottom_offset - 12   # 12px bottom margin
    row2_cy = knob_cy
    lines += [
        f'frame   x={dbx} y={dby} w={dbw} h={dbh} title="PAD DETAIL"',
        f'stepper cx={nav_cx} cy={stepper_cy} w=220 h={stepper_h} label="" key=detail_pad_sel '
        f'get=detail_pad_name idx=detail_pad_sel count=detail_pad_count min=0 max=15 numbered=1',
        f'knob    cx={nav_cx} cy={knob_cy} r={knob_r} label="GAIN" key=detail_gain min=0 max=2 pct=50',
        f'readout cx={dbx + 640} cy={stepper_cy} w=700 h=44 label="" get=detail_sample_info',
        f'button  cx={dbx + 1120} cy={stepper_cy} label="   PLAY   " key=detail_play color={ACCENT_HEX}',
        f'toggle  cx={dbx + 350} cy={row2_cy} label="LOCK" key=detail_lock',
        f'button  cx={dbx + 650} cy={row2_cy} label="CLEAR" key=detail_clear',
        f'button  cx={dbx + 950} cy={row2_cy} label="REROLL" key=detail_reroll',
    ]
    # Verify row1 clears the divider and knob text stays inside the frame -
    # assertions, not comments, so a future coordinate tweak that breaks
    # either fails loudly instead of shipping a silent overlap again.
    assert stepper_cy - stepper_h // 2 >= dby + FRAME_TITLE_DIVIDER_Y, 'stepper row overlaps frame title'
    assert knob_cy + knob_text_bottom_offset <= dby + dbh - 4, 'GAIN value text overflows PAD DETAIL frame'

    return '\n'.join(lines) + '\n'


def pads_pages():
    all_indices = list(range(16))
    chunks = [all_indices[i:i + PADS_PER_PAGE] for i in range(0, 16, PADS_PER_PAGE)]
    names = ['PADS 1-6', 'PADS 7-12', 'PADS 13-16']
    return '\n'.join(pads_page(name, chunk) for name, chunk in zip(names, chunks))


if __name__ == '__main__':
    import sys
    out = HEADER + '\n' + pads_pages() + '\n' + detail_tab()
    dest = sys.argv[1] if len(sys.argv) > 1 else '/dev/stdout'
    with open(dest, 'w') as f:
        f.write(out)
    print(f'wrote {dest}', file=sys.stderr)
