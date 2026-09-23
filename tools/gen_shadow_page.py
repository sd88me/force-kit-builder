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
# - MAX_FRAMES was 6 per tab (force_shadow.c), a SEPARATE cap from the
#   64-widget MAX_WIDGETS one - frames don't count against MAX_WIDGETS,
#   but they had their own budget, silently dropped past 6
#   (`if (n_page_frames >= MAX_FRAMES) return;`, no error, no log). The
#   original 16-pad-one-page PADS design had 16 frames; only the first 6
#   rendered on real hardware. First fix split PADS into three pages of
#   up to 6 pads each - superseded a day later (see "v4.2" below) once
#   MAX_FRAMES was raised instead, since a single 16-pad page was what
#   was actually wanted; kept as design history, not live code.
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

HEADER = '''# ForceKitBuilder — shadow-GUI page (v4.2: two pages - a single 16-pad
# PADS performance grid + DETAIL single-pad view). See DESIGN.md's "v4",
# "v4.1", and "v4.2" sections for the full redesign history and the real
# bugs live-device testing caught that no offline render could.
#
# v4.2 (2026-09-23, later same day): back to one 16-pad PADS page -
# force-shadow's own MAX_FRAMES was raised from 6 to 20 (src/
# force_shadow.c, this repo's own upstream constant, rebuilt and
# redeployed) rather than working around it with three pages. Checked
# before raising, not just bumped blind: page_frames et al are
# duplicated per-tab across all 40 addon slots x 8 tabs
# (tab_snapshot_t's data_addon_tabs[] table) - the extra 14 frames add
# ~125KB total, negligible next to that same table's ~11MB
# MAX_WIDGETS-driven allocation. MAX_WIDGETS=64 is unchanged and is a
# real constraint again at 16 pads/page: back to 3 controls per pad
# (PLAY/pill/REROLL - see v4.3 below), CLEAR doesn't fit alongside the
# top-bar "last played" readout on one 16-pad page, same tradeoff v4's
# first pass already made for the same reason.
#
# v4.3 (2026-09-23, later still): the third control per pad is now a
# tap-to-select-and-jump-to-DETAIL readout "pill" (abbreviated category,
# "L:" prefixed when locked), not a LOCK toggle - see pads_cell()'s own
# comment in tools/gen_shadow_page.py for the full reasoning and the
# force_shadow.c engine change (readout key=/val= SET-before-goto) it
# depends on. Locking itself didn't move - DETAIL's own LOCK toggle
# still does that, next to GENERATE ALL/CLEAR ALL, the actions it
# protects against.
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


# ---- PADS page: single tab, 16 pads, 4 cols x 4 rows -----------------------
# MAX_FRAMES is 20 now (force-shadow's own src/force_shadow.c, raised
# from 6 - see HEADER), so all 16 per-pad frames fit on one tab; asserted
# below rather than just assumed. MAX_WIDGETS=64 is still real though:
# 16 pads x 4 controls would be exactly 64 with zero room for the top-bar
# "last played" readout this page also needs.
#
# v4.3 (readout pill, replacing the per-pad LOCK toggle): DETAIL already
# has its own LOCK toggle (driven by its pad-select stepper) right next
# to GENERATE ALL/CLEAR ALL - the actions locking actually protects
# against - so the PADS-grid LOCK toggle was redundant control, not a
# unique one. Swapped 1-for-1 for a readout "pill": tapping it both
# selects that pad (key=detail_pad_sel val=<i>) and jumps to DETAIL
# (goto=1, DETAIL's tab index - see force_shadow.c's parse_shadow_page_
# conf(), tabs are 0-indexed in file order) in one tap, via
# force_shadow.c's readout key=/val= SET-before-goto support (added
# alongside this page revision - see that repo's own DESIGN.md). Same 3
# widgets/pad as before (PLAY/pill/REROLL), so this needed no MAX_WIDGETS
# change. Lock state still shows at a glance: the pill's own GET text
# (daemon.mjs's pad_pill_N) prefixes "L:" when locked.
#
# Pill text is necessarily short (abbreviated category, not the full
# sample name): the pill is only 130px wide (114px usable after the
# readout's fixed 8px each-side padding), and force_shadow.c's readout
# text draws at a fixed 14px/char at this widget's scale (FONT_HI_2_0_W,
# src/font_hi.h) - confirmed against source and a live-preview mockup,
# not assumed - so roughly 8 characters is the real ceiling, ~6 once the
# "L:" lock prefix is included. CAT_ABBR below is deliberately terse for
# exactly this reason. The font itself only has "A-Z0-9.-/>%+:" (space
# too) - font8x8.h's font_chars - no brackets or bullet glyph, which is
# why "L:" (not "[L]" or a lock icon) is the prefix.
CAT_ABBR = {
    'kick': 'KICK', 'snare': 'SNR', 'rim': 'RIM', 'clap': 'CLAP',
    'hat': 'HAT', 'closed_hat': 'CHAT', 'open_hat': 'OHAT',
    'tom': 'TOM', 'conga': 'CNGA', 'percussion': 'PERC',
    'crash': 'CRSH', 'ride': 'RIDE', 'cymbal': 'CYM', 'fx': 'FX',
    'glitch': 'GLI', 'vox': 'VOX', 'bass': 'BASS', 'synth': 'SYN',
    'stab': 'STB', 'chord': 'CHD', 'lead': 'LEAD', 'pad': 'PAD',
    'other': 'OTH',
}
DETAIL_TAB_INDEX = 1   # [tab PADS] is 0, [tab DETAIL] is 1 - file order, see force_shadow.c's parse_shadow_page_conf()

MAX_FRAMES = 20   # force-shadow/src/force_shadow.c's own constant, mirrored here for the assert below
PADS_ROW_Y = [82, 244, 406, 568]
PADS_COL_X = [20, 335, 650, 965]
PADS_CELL_W, PADS_CELL_H = 295, 150


def pads_cell(pad_num, pad_index, x, y):
    # Left half = PLAY, right half = pill over REROLL, stacked. PLAY's
    # label is not padded - a padded label bled into the neighbouring
    # pad's column in an earlier draft (checked with the real
    # text_width_1_5() formula this time, not the preview tool's ~50%-
    # too-generous approximation that produced that bug originally).
    left_cx = x + PADS_CELL_W // 4
    right_cx = x + (PADS_CELL_W * 3) // 4
    mid_cy = y + 92
    pill_cy = y + 68
    reroll_cy = y + 118
    return '\n'.join([
        # color_key: this pad's own frame lights up to match its assigned
        # category (force-shadow's frame color_key=, same mechanism as
        # DETAIL's PAD DETAIL frame) - daemon.mjs's pad_color_N.
        f'frame   x={x} y={y} w={PADS_CELL_W} h={PADS_CELL_H} title="PAD {pad_num}" color_key=pad_color_{pad_index}',
        f'button  cx={left_cx} cy={mid_cy} label="PLAY" key=play_pad_{pad_index} color={ACCENT_HEX}',
        f'readout cx={right_cx} cy={pill_cy} w=130 h=30 label="" get=pad_pill_{pad_index} '
        f'key=detail_pad_sel val={pad_index} goto={DETAIL_TAB_INDEX}',
        f'button  cx={right_cx} cy={reroll_cy} label="REROLL" key=reroll_pad_{pad_index}',
    ])


def pads_page():
    assert 16 <= MAX_FRAMES, f"16 pad frames exceeds force-shadow's MAX_FRAMES={MAX_FRAMES}"
    lines = ['[tab PADS]', TOPBAR_LASTPLAYED, '']
    for row in range(4):
        for col in range(4):
            pad_index = row * 4 + col
            x, y = PADS_COL_X[col], PADS_ROW_Y[row]
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
        # color_key: force_shadow.c GET-polls detail_pad_color (daemon.mjs)
        # every refresh cycle and tints this frame's fill to match the
        # selected pad's category - the shadow-GUI stretch goal from the
        # pad-colour feature, reusing the same core/pad_colors.mjs palette
        # the web GUI's colour pickers and the XPM export both already use.
        f'frame   x={dbx} y={dby} w={dbw} h={dbh} title="PAD DETAIL" color_key=detail_pad_color',
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


if __name__ == '__main__':
    import sys
    out = HEADER + '\n' + pads_page() + '\n' + detail_tab()
    dest = sys.argv[1] if len(sys.argv) > 1 else '/dev/stdout'
    with open(dest, 'w') as f:
        f.write(out)
    print(f'wrote {dest}', file=sys.stderr)
