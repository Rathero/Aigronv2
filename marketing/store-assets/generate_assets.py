#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AIGRONS — Generador de assets para stores (icono, feature graphic, capturas,
OG image y key art). Mismo ADN visual del juego: sprites 16x16 procedurales
con contorno, paleta neon sobre #070710, auroras y logo pixel.

Uso: python3 generate_assets.py [carpeta_salida]
"""
import os, sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)

BG = (7, 7, 16)
CYAN = (78, 240, 232); MAGENTA = (255, 78, 205); GOLD = (255, 211, 78)
PURPLE = (167, 139, 250); GREEN = (126, 242, 154)
TEXT = (240, 240, 250); MUTED = (154, 154, 184)
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def F(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)

# ----------------------------- RNG (mulberry32) ------------------------------
def mulberry32(a):
    state = [a & 0xFFFFFFFF]
    def rnd():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) ^ t
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rnd

PALETTES = [
    ["#2b0a0a", "#7a1f1f", "#e8472b", "#ff8c42", "#ffd34e"],  # volcan
    ["#0a1a2b", "#1f4d7a", "#2bb5e8", "#7ef2ff", "#e0fbff"],  # cristal
    ["#150a2b", "#3d1f7a", "#7a2be8", "#c084fc", "#f3e8ff"],  # vacio
    ["#0a2b14", "#1f7a3d", "#2be86b", "#7ef29a", "#dcffe8"],  # planta
    ["#2b270a", "#7a6e1f", "#e8d22b", "#fff07e", "#fffbe0"],  # tormenta
    ["#2b0a1f", "#7a1f57", "#e82b9d", "#ff7ed2", "#ffe0f3"],  # rosa
]
def hex2rgb(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def gen_grid(seed, pal_len, S=16):
    rnd = mulberry32(seed)
    grid = [[0]*(S//2) for _ in range(S)]
    for y in range(S):
        for x in range(S//2):
            d = math.hypot(x - S/4, (y - S/2) * 0.8) / (S / 2.6)
            grid[y][x] = 1 + int(rnd() * (pal_len - 1)) if rnd() > d * 0.85 else 0
    for y in range(1, S-1):
        for x in range(1, S//2-1):
            if grid[y][x] and not grid[y-1][x] and not grid[y+1][x] and not grid[y][x-1] and not grid[y][x+1]:
                grid[y][x] = 0
    ey, ex = 4 + int(rnd()*4), 2 + int(rnd()*3)
    grid[ey][ex] = 0
    if ex + 1 < S//2: grid[ey][ex+1] = pal_len - 1
    return grid

def creature(seed, pal_idx, px, silhouette=False):
    """Sprite 16x16 espejado con contorno, escalado a px (nearest)."""
    S = 16
    pal = [hex2rgb(c) for c in PALETTES[pal_idx % len(PALETTES)]]
    g = gen_grid(seed, len(pal), S)
    full = [[(g[y][x] if x < S//2 else g[y][S-1-x]) for x in range(S)] for y in range(S)]
    img = Image.new("RGBA", (S+2, S+2), (0, 0, 0, 0))
    d = img.load()
    for y in range(S):
        for x in range(S):
            if not full[y][x]: continue
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                if nx < 0 or ny < 0 or nx >= S or ny >= S or not full[ny][nx]:
                    d[nx+1, ny+1] = (5, 5, 12, 255)
    for y in range(S):
        for x in range(S):
            v = full[y][x]
            if v: d[x+1, y+1] = (*( (16,16,30) if silhouette else pal[v-1]), 255)
    return img.resize((px, px), Image.NEAREST)

# ------------------------------- logo pixel ----------------------------------
GLYPHS = {
"A": [".###.","#...#","#...#","#####","#...#","#...#","#...#"],
"G": [".####","#....","#....","#.###","#...#","#...#",".###."],
"I": ["#####","..#..","..#..","..#..","..#..","..#..","#####"],
"N": ["#...#","##..#","##..#","#.#.#","#..##","#..##","#...#"],
"O": [".###.","#...#","#...#","#...#","#...#","#...#",".###."],
"R": ["####.","#...#","#...#","####.","#.#..","#..#.","#...#"],
"S": [".####","#....","#....",".###.","....#","....#","####."],
}
def logo(px, word="AIGRONS"):
    """Logo pixel con degradado vertical blanco->cyan->magenta y glow."""
    cols = sum(5 + 1 for _ in word) - 1
    base = Image.new("RGBA", (cols, 7), (0, 0, 0, 0))
    d = base.load()
    def grad(row):
        t = row / 6.0
        if t < .45:
            k = t / .45; a, b = (255,255,255), CYAN
        else:
            k = (t-.45)/.55; a, b = CYAN, MAGENTA
        return tuple(int(a[i]+(b[i]-a[i])*k) for i in range(3))
    x0 = 0
    for ch in word:
        for ry, row in enumerate(GLYPHS[ch]):
            for rx, c in enumerate(row):
                if c == "#": d[x0+rx, ry] = (*grad(ry), 255)
        x0 += 6
    img = base.resize((cols*px, 7*px), Image.NEAREST)
    glow = img.filter(ImageFilter.GaussianBlur(px*1.6))
    out = Image.new("RGBA", img.size, (0,0,0,0))
    out.alpha_composite(glow); out.alpha_composite(glow); out.alpha_composite(img)
    return out

# ------------------------------ fondo atmósfera ------------------------------
def aurora_bg(w, h, seed=7, particles=90, grid=True):
    img = Image.new("RGB", (w, h), BG)
    blobs = Image.new("RGB", (w, h), BG)
    bd = ImageDraw.Draw(blobs)
    rnd = mulberry32(seed)
    cols = [(59,29,122), (20,59,77), (90,18,66), (40,20,90)]
    for i, c in enumerate(cols):
        cx, cy = int(rnd()*w), int(rnd()*h)
        r = int(min(w, h) * (0.45 + rnd()*0.35))
        bd.ellipse([cx-r, cy-r, cx+r, cy+r], fill=c)
    blobs = blobs.filter(ImageFilter.GaussianBlur(min(w, h)//5))
    img = Image.blend(img, blobs, 0.55)
    _ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(_ov)
    if grid:
        step = max(40, w//24)
        for x in range(0, w, step): d.line([(x,0),(x,h)], fill=(*CYAN, 10))
        for y in range(0, h, step): d.line([(0,y),(w,y)], fill=(*CYAN, 10))
    for _ in range(particles):
        x, y = rnd()*w, rnd()*h
        s = 2 + rnd()*4
        c = [CYAN, MAGENTA, GOLD, PURPLE][int(rnd()*4)]
        d.rectangle([x, y, x+s, y+s], fill=(*c, int(50+rnd()*110)))
    img = Image.alpha_composite(img.convert("RGBA"), _ov).convert("RGB")
    # viñeta
    vig = Image.new("L", (w, h), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-w*0.25, -h*0.25, w*1.25, h*1.25], fill=110)
    vig = vig.filter(ImageFilter.GaussianBlur(min(w, h)//4))
    img = Image.composite(img, Image.new("RGB", (w, h), (2, 2, 6)),
                          vig.point(lambda p: min(255, p+145)))
    return img.convert("RGBA")

def glow_ellipse(img, cx, cy, rx, ry, color, alpha=90):
    g = Image.new("RGBA", img.size, (0,0,0,0))
    gd = ImageDraw.Draw(g)
    gd.ellipse([cx-rx, cy-ry, cx+rx, cy+ry], fill=(*color, alpha))
    img.alpha_composite(g.filter(ImageFilter.GaussianBlur(max(rx, ry)//3)))

def center_text(d, cx, y, txt, font, fill, anchor="ma"):
    d.text((cx, y), txt, font=font, fill=fill, anchor=anchor)

def chip(img, cx, cy, txt, font, color):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tw = d.textlength(txt, font=font)
    pad, hh = 36, font.size + 36
    box = [cx-tw/2-pad, cy-hh/2, cx+tw/2+pad, cy+hh/2]
    d.rounded_rectangle(box, radius=hh//2, fill=(*color, 22))
    d.rounded_rectangle(box, radius=hh//2, outline=(*color, 200), width=3)
    d.text((cx, cy), txt, font=font, fill=(*color, 255), anchor="mm")
    img.alpha_composite(layer)

# ================================ ICONO =======================================
def make_icon(size):
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    # degradado radial morado->magenta
    rad = Image.new("L", (size, size), 0)
    rd = ImageDraw.Draw(rad)
    for i in range(size//2, 0, -2):
        rd.ellipse([size/2-i, size/2-i, size/2+i, size/2+i],
                   fill=int(255*(1-i/(size/2))))
    purple_layer = Image.new("RGBA", (size, size), (59, 29, 122, 255))
    magenta_layer = Image.new("RGBA", (size, size), (140, 30, 110, 255))
    img.paste(Image.composite(magenta_layer, purple_layer, rad), (0, 0))
    glow_ellipse(img, size//2, int(size*0.56), int(size*0.34), int(size*0.30), MAGENTA, 120)
    # criatura legendaria (la "única" del altar)
    c = creature(992617, 0, int(size*0.62))
    img.alpha_composite(c, (int(size*0.19), int(size*0.16)))
    # destellos
    rnd = mulberry32(99)
    dd = ImageDraw.Draw(img)
    for _ in range(14):
        x, y = rnd()*size, rnd()*size*0.5
        s = size*0.008 + rnd()*size*0.012
        dd.rectangle([x, y, x+s, y+s], fill=(*GOLD, 200))
    # marco dorado de rareza
    bw = max(6, size//42)
    for i, col in enumerate([GOLD, (180, 140, 30), GOLD]):
        off = bw*i
        dd.rectangle([off, off, size-1-off, size-1-off], outline=col, width=bw)
    return img.convert("RGB")

# ============================ FEATURE GRAPHIC =================================
def make_feature(lang):
    w, h = 1024, 500
    img = aurora_bg(w, h, seed=11, particles=60)
    lg = logo(6)
    img.alpha_composite(lg, (60, 110))
    tag = "Un álbum de criaturas imposibles" if lang == "es" else "An album of impossible creatures"
    sub = "Nuevo cada temporada · Gratis" if lang == "es" else "New every season · Free"
    d = ImageDraw.Draw(img)
    d.text((64, 230), tag, font=F(34), fill=TEXT)
    d.text((64, 282), sub, font=F(26), fill=GOLD)
    # criaturas a la derecha
    for i, (seed, pal, px, x, y) in enumerate([
            (992617, 0, 190, 650, 40), (771203, 1, 150, 820, 150),
            (445918, 2, 130, 660, 300), (31337, 3, 110, 840, 340)]):
        glow_ellipse(img, x+px//2, y+px//2, px//2+18, px//2+18,
                     [MAGENTA, CYAN, PURPLE, GREEN][i], 70)
        img.alpha_composite(creature(seed, pal, px), (x, y))
    return img.convert("RGB")

# =============================== CAPTURAS =====================================
SHOT_W, SHOT_H = 1080, 1920
CAPTIONS = {
 "es": ["HOY HA NACIDO ALGO QUE\nNO VOLVERÁ A NACER",
        "UNA TIRADA GRATIS\nCADA DÍA",
        "COMBATES DE\n2 MINUTOS",
        "COMPLETA EL ÁLBUM\nDE LA TEMPORADA",
        "NUNCA\nPAY-TO-WIN"],
 "en": ["BORN TODAY.\nGONE AT MIDNIGHT.",
        "A FREE PULL\nEVERY DAY",
        "2-MINUTE\nBATTLES",
        "COMPLETE THE\nSEASON ALBUM",
        "NEVER\nPAY-TO-WIN"],
}
ACCENTS = [MAGENTA, CYAN, GOLD, GOLD, GREEN]

def fit_font(d, txt, max_w, start=76, minimum=40):
    size = start
    while size > minimum and d.textlength(txt, font=F(size)) > max_w:
        size -= 2
    return F(size)

def shot_base(idx, lang):
    img = aurora_bg(SHOT_W, SHOT_H, seed=20+idx, particles=110)
    d = ImageDraw.Draw(img)
    cap = CAPTIONS[lang][idx]
    lines = cap.split("\n")
    # un solo tamaño para todas las líneas: el de la más larga
    longest = max(lines, key=lambda l: d.textlength(l, font=F(40)))
    font = fit_font(d, longest, SHOT_W - 140)
    y = 150
    for line in lines:
        center_text(d, SHOT_W//2, y, line, font, TEXT)
        y += int(font.size * 1.32)
    d.rectangle([SHOT_W//2-90, y+18, SHOT_W//2+90, y+26], fill=ACCENTS[idx])
    # footer
    lg = logo(3)
    img.alpha_composite(lg, (SHOT_W//2 - lg.width//2, SHOT_H-150))
    center_text(d, SHOT_W//2, SHOT_H-66, "aigrons.com", F(30, False), MUTED)
    return img, y + 80

def shot_altar(lang):
    img, top = shot_base(0, lang)
    d = ImageDraw.Draw(img)
    cx, cy = SHOT_W//2, top + 480
    glow_ellipse(img, cx, cy, 330, 330, MAGENTA, 110)
    c = creature(992617, 5, 520)
    img.alpha_composite(c, (cx-260, cy-260))
    _l = Image.new("RGBA", img.size, (0,0,0,0))
    ImageDraw.Draw(_l).ellipse([cx-200, cy+280, cx+200, cy+330], fill=(*MAGENTA, 60))
    img.alpha_composite(_l)
    center_text(d, cx, cy+380, "VESPERINA", F(64), GOLD)
    center_text(d, cx, cy+465, "★ ÚNICA DEL DÍA" if lang == "es" else "★ TODAY'S UNIQUE", F(34), GOLD)
    center_text(d, cx, cy+540, ("Desaparece en" if lang == "es" else "Vanishes in"), F(30), MAGENTA)
    center_text(d, cx, cy+590, "07:42:13", F(72), TEXT)
    return img

def shot_daily(lang):
    img, top = shot_base(1, lang)
    d = ImageDraw.Draw(img)
    cx, cy = SHOT_W//2, top + 460
    glow_ellipse(img, cx, cy, 300, 320, GOLD, 90)
    # huevo pixel
    egg = Image.new("RGBA", (18, 22), (0,0,0,0))
    ed = egg.load()
    rnd = mulberry32(777)
    for y in range(22):
        for x in range(18):
            dx, dy = (x-8.5)/8.0, (y-11)/10.0
            if dx*dx + dy*dy <= 1:
                base = (236, 232, 255, 255) if (x+y) % 7 else (200, 180, 255, 255)
                ed[x, y] = base
    for x, y in [(8,8),(9,9),(10,8),(9,7),(11,10)]:
        ed[x, y] = (90, 60, 160, 255)
    egg = egg.resize((430, 525), Image.NEAREST)
    img.alpha_composite(egg, (cx-215, cy-280))
    # rayos
    for ang in range(0, 360, 30):
        x2 = cx + math.cos(math.radians(ang)) * 360
        y2 = cy + math.sin(math.radians(ang)) * 360
        x1 = cx + math.cos(math.radians(ang)) * 300
        y1 = cy + math.sin(math.radians(ang)) * 300
        _l = Image.new("RGBA", img.size, (0,0,0,0))
        ImageDraw.Draw(_l).line([x1, y1, x2, y2], fill=(*GOLD, 140), width=8)
        img.alpha_composite(_l)
    chip(img, cx, cy+400, "GRATIS · CADA DÍA" if lang == "es" else "FREE · EVERY DAY", F(36), GOLD)
    return img

def shot_battle(lang):
    img, top = shot_base(2, lang)
    d = ImageDraw.Draw(img)
    cy = top + 420
    teamA = [(992617, 0), (771203, 1), (445918, 2)]
    teamB = [(31337, 3), (424242, 4), (990137, 5)]
    for i, (seed, pal) in enumerate(teamA):
        x, y = 120, cy - 260 + i*240
        img.alpha_composite(creature(seed, pal, 200), (x, y))
        d.rectangle([x, y+210, x+200, y+222], fill=(20,20,40))
        d.rectangle([x, y+210, x+int(200*(0.9-0.2*i)), y+222], fill=GREEN)
    for i, (seed, pal) in enumerate(teamB):
        x, y = SHOT_W-320, cy - 260 + i*240
        img.alpha_composite(creature(seed, pal, 200).transpose(Image.FLIP_LEFT_RIGHT), (x, y))
        d.rectangle([x, y+210, x+200, y+222], fill=(20,20,40))
        d.rectangle([x, y+210, x+int(200*(0.45+0.15*i)), y+222], fill=MAGENTA)
    center_text(d, SHOT_W//2, cy-40, "VS", F(110), TEXT)
    center_text(d, SHOT_W//2 + 160, cy-180, "-42", F(64), GOLD)
    chip(img, SHOT_W//2, cy+560, "1 DECISIÓN POR TURNO" if lang == "es" else "1 DECISION PER TURN", F(34), CYAN)
    return img

def shot_album(lang):
    img, top = shot_base(3, lang)
    d = ImageDraw.Draw(img)
    x0, y0 = 110, top + 90
    cell, gap = 200, 18
    rnd = mulberry32(20260612)
    k = 0
    for row in range(4):
        for col in range(4):
            x, y = x0 + col*(cell+gap), y0 + row*(cell+gap)
            known = ((k+1) * 2654435761 % 1000) < 480
            rar = GOLD if k == 5 else (PURPLE if k in (2, 11) else ((90,167,255) if k % 5 == 0 else (35,35,61)))
            d.rounded_rectangle([x, y, x+cell, y+cell], radius=22,
                                fill=(12,12,28,255), outline=(*rar, 230), width=3)
            spr = creature(7000 + int(rnd()*999999), k % 6, 150, silhouette=not known)
            img.alpha_composite(spr, (x+25, y+25))
            if not known:
                center_text(d, x+cell//2, y+cell//2-28, "?", F(56), (61,61,96))
            k += 1
    # barra
    by = y0 + 4*(cell+gap) + 50
    d.rounded_rectangle([x0, by, SHOT_W-110, by+34], radius=17, fill=(10,10,24), outline=(35,35,61), width=2)
    d.rounded_rectangle([x0, by, x0 + int((SHOT_W-220-x0)*0.36)+110, by+34], radius=17, fill=GOLD)
    center_text(d, SHOT_W//2, by+70, "64 / 180", F(44), TEXT)
    return img

def shot_fair(lang):
    img, top = shot_base(4, lang)
    d = ImageDraw.Draw(img)
    cx = SHOT_W//2
    big = "EL DINERO NO\nCOMPRA VICTORIAS" if lang == "es" else "MONEY DOESN'T\nBUY WINS"
    y = top + 150
    for line in big.split("\n"):
        center_text(d, cx, y, line, F(64), GREEN)
        y += 86
    chips = (["✔ Mismo álbum para todos", "✔ Ranking solo por habilidad",
              "✔ Sin loot boxes sin techo", "✔ Combate validado en servidor"]
             if lang == "es" else
             ["✔ Same album for everyone", "✔ Skill-only ranking",
              "✔ No uncapped loot boxes", "✔ Server-validated combat"])
    yy = y + 120
    for t in chips:
        chip(img, cx, yy, t, F(34), GREEN)
        yy += 130
    # tres criaturas espectadoras
    for i, (seed, pal) in enumerate([(771203, 1), (992617, 0), (445918, 2)]):
        img.alpha_composite(creature(seed, pal, 170), (140 + i*310, yy + 60))
    return img

# ============================== OG / KEY ART ==================================
def make_og():
    w, h = 1200, 630
    img = aurora_bg(w, h, seed=5, particles=70)
    lg = logo(7)
    img.alpha_composite(lg, (w//2 - lg.width//2, 120))
    d = ImageDraw.Draw(img)
    center_text(d, w//2, 320, "Criaturas que no existían. Cada temporada, un álbum nuevo.", F(34), TEXT)
    center_text(d, w//2, 380, "Gratis · En tu navegador · Nunca pay-to-win", F(26), GOLD)
    for i, (seed, pal) in enumerate([(771203, 1), (992617, 0), (445918, 2), (31337, 3), (424242, 4)]):
        px = 120 if i % 2 else 150
        img.alpha_composite(creature(seed, pal, px), (90 + i*215, 460 - (px-120)//2))
    return img.convert("RGB")

def make_keyart():
    w, h = 1920, 1080
    img = aurora_bg(w, h, seed=3, particles=140)
    lg = logo(9)
    img.alpha_composite(lg, (w//2 - lg.width//2, 90))
    d = ImageDraw.Draw(img)
    center_text(d, w//2, 270, "AQUÍ NACEN COSAS QUE NO EXISTÍAN", F(40), GOLD)
    lineup = [(445918, 2, 240), (771203, 1, 300), (992617, 0, 420), (31337, 3, 300), (424242, 4, 240)]
    x = 180
    for seed, pal, px in lineup:
        y = 760 - px
        glow_ellipse(img, x+px//2, y+px//2, px//2+30, px//2+30,
                     [PURPLE, CYAN, MAGENTA, GREEN, GOLD][lineup.index((seed, pal, px))], 80)
        img.alpha_composite(creature(seed, pal, px), (x, y))
        x += px + 60
    _l = Image.new("RGBA", img.size, (0,0,0,0))
    ImageDraw.Draw(_l).ellipse([w//2-560, 800, w//2+560, 880], fill=(*MAGENTA, 40))
    img.alpha_composite(_l)
    center_text(d, w//2, 940, "Gratis · 2 minutos al día · aigrons.com", F(34), TEXT)
    return img.convert("RGB")

# ================================== MAIN ======================================
def main():
    make_icon(1024).save(f"{OUT}/icon_1024.png")
    make_icon(512).save(f"{OUT}/icon_512.png")
    for lang in ("es", "en"):
        make_feature(lang).save(f"{OUT}/feature_graphic_{lang}_1024x500.png")
        for i, fn in enumerate([shot_altar, shot_daily, shot_battle, shot_album, shot_fair]):
            fn(lang).convert("RGB").save(f"{OUT}/screenshot_{lang}_{i+1}.png")
    make_og().save(f"{OUT}/og_image_1200x630.png")
    make_keyart().save(f"{OUT}/promo_key_art_1920x1080.png")
    print("OK ->", OUT)

if __name__ == "__main__":
    main()
