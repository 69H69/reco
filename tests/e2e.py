"""Test de bout en bout de Reco (Edge avec caméra, micro et écran factices).

1. `npx wrangler dev --port 8787 --local` (avec INVITE_CODE=test-local-123 dans .dev.vars)
2. python tests/e2e.py [mode] [secondes]     mode = screen+cam (défaut) | screen | cam
"""
import json, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"
MODE = sys.argv[1] if len(sys.argv) > 1 else "screen+cam"
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 25
OUT = Path(tempfile.gettempdir()) / "reco-e2e"
OUT.mkdir(exist_ok=True)
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]


def check(cond, msg):
    print(("OK   " if cond else "ÉCHEC ") + msg, flush=True)
    if not cond:
        sys.exit(1)


def login(pg, name, code="test-local-123"):
    pg.goto(f"{BASE}/?fakeScreen=1")
    pg.fill("#l-name", name); pg.fill("#l-code", code); pg.click("#f-login button")


def http(path, method="GET", headers=None):
    req = urllib.request.Request(f"{BASE}{path}", method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge", headless=True, args=ARGS)
    ctx = b.new_context(permissions=["camera", "microphone", "clipboard-read", "clipboard-write"], viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    login(pg, "Alex", "mauvais")
    pg.wait_for_function("document.querySelector('#l-err').textContent.length > 0")
    check("incorrect" in pg.inner_text("#l-err"), "mauvais code refusé")
    pg.fill("#l-code", "test-local-123"); pg.click("#f-login button")
    pg.wait_for_selector("#v-lib:not([hidden])")
    check(True, "connexion et bibliothèque")

    # ── enregistrement avec envoi en continu ──
    pg.click("#b-new"); pg.wait_for_selector("#v-setup:not([hidden])")
    pg.click(f'.mode[data-mode="{MODE}"]'); pg.click("#b-prepare")
    pg.wait_for_selector("#b-go:not([hidden])", timeout=15000)
    pg.wait_for_function("document.querySelector('#pv').videoWidth > 0", timeout=15000)
    wh = pg.evaluate("[document.querySelector('#pv').videoWidth, document.querySelector('#pv').videoHeight]")
    check(True, f"aperçu composé {wh[0]}x{wh[1]}")
    pg.click("#b-go"); pg.wait_for_selector("#v-rec:not([hidden])")
    time.sleep(2.6 + SECS - 3)
    pg.click("#r-pause"); time.sleep(1.5); pg.click("#r-pause"); time.sleep(3)
    sent, inflight, local = pg.evaluate("[R.up ? R.up.parts.length : -1, R.up && R.up.busy ? 1 : 0, R.localSize]")
    expected = int(local // (8 * 1024 * 1024))
    check(sent + inflight >= expected, f"{local / 1e6:.1f} Mo enregistrés : {sent} morceau(x) déjà en ligne + {inflight} en cours AVANT l'arrêt (attendu {expected})")
    pg.click("#r-stop")
    pg.wait_for_selector("#x-share:not([hidden])", timeout=60000)
    link = pg.input_value("#x-link"); vid = link.rsplit("/", 1)[-1]
    check("/v/" in link and "Prête" in pg.inner_text("#x-status"), f"lien prêt dès l'arrêt : {link}")
    # titre + découpe (début à 2 s)
    pg.fill("#x-title", f"Test e2e {MODE}")
    pg.wait_for_selector("#x-trim:not([hidden])")
    pg.evaluate("const s=document.querySelector('#x-ts'); s.value=2; s.dispatchEvent(new Event('input'))")
    pg.click("#x-done"); pg.wait_for_selector("#v-lib:not([hidden])")
    html = http(f"/v/{vid}")[2].decode()
    check(f"Test e2e {MODE}" in html and "#t=2" in html, "titre et découpe enregistrés (lecture à partir de 2 s)")

    # ── lecture publique + compteur de vues (onglet non connecté) ──
    pub = b.new_context().new_page()
    pub.goto(link)
    pub.wait_for_function("document.querySelector('#pv').readyState >= 1", timeout=15000)
    pub.evaluate("document.querySelector('#pv').play()"); time.sleep(2)
    t_now = pub.evaluate("document.querySelector('#pv').currentTime")
    check(t_now >= 2, f"le lecteur démarre après la découpe (t = {t_now:.1f} s)")
    pg.reload(); pg.wait_for_selector(f'.vc[data-id="{vid}"]')
    check("1 vue" in pg.inner_text(f'.vc[data-id="{vid}"]'), "compteur de vues : 1 vue")

    # ── import d'un fichier > 8 Mo (plusieurs morceaux) ──
    src = OUT / "import.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=12", "-f", "lavfi", "-i", "sine=f=440:duration=12",
                    "-c:v", "libx264", "-b:v", "12M", "-c:a", "aac", "-shortest", str(src)], check=True)
    pg.set_input_files("#f-import", str(src))
    pg.wait_for_selector("#x-share:not([hidden])", timeout=60000)
    ivid = pg.input_value("#x-link").rsplit("/", 1)[-1]
    st, hd, body = http(f"/f/{ivid}")
    check(st == 200 and len(body) == src.stat().st_size, f"import de {src.stat().st_size / 1e6:.1f} Mo reconstitué à l'octet près")
    check(http(f"/t/{ivid}")[0] == 200, "miniature générée pour l'import")
    pg.click("#x-done"); pg.wait_for_selector("#v-lib:not([hidden])")

    # ── un autre utilisateur ne peut pas supprimer ──
    other = b.new_context().new_page(); login(other, "Pote"); other.wait_for_selector("#v-lib:not([hidden])")
    r = other.evaluate(f"fetch('/api/videos/{vid}',{{method:'DELETE'}}).then(r=>r.status)")
    check(r == 403, "un autre utilisateur ne peut pas supprimer la vidéo (403)")
    check(other.locator(f'.vc[data-id="{vid}"] [data-act="del"]').count() == 0, "et le bouton Supprimer ne lui est pas proposé")
    b.close()

# ── contrôles du fichier enregistré ──
st, hd, body = http(f"/f/{vid}", headers={"Range": "bytes=0-1023"})
check(st == 206 and len(body) == 1024, "lecture partielle (Range 206)")
st, hd, body = http(f"/f/{vid}")
ext = "mp4" if "mp4" in hd.get("Content-Type", hd.get("content-type", "")) else "webm"
f = OUT / f"{vid}.{ext}"; f.write_bytes(body)
info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", str(f)], capture_output=True, text=True).stdout)
kinds = {s["codec_type"]: s for s in info["streams"]}
check("video" in kinds and "audio" in kinds, f"{ext} {kinds['video']['codec_name']} {kinds['video']['width']}x{kinds['video']['height']} + {kinds.get('audio', {}).get('codec_name')}")
dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-map", "0:v", "-f", "null", "-", "-stats"], capture_output=True, text=True).stderr
tm = [x for x in dec.replace("\r", "\n").split("\n") if "time=" in x]
real = tm[-1].split("time=")[1].split()[0] if tm else "?"
h, mi, se = real.split(":"); real_s = int(h) * 3600 + int(mi) * 60 + float(se)
check(abs(real_s - SECS) < 1.5, f"durée réelle {real_s:.1f} s pour {SECS:.0f} s enregistrées (pause exclue), fichier assemblé depuis les morceaux")
errs = [l for l in logs if ("error" in l.lower() or "warn" in l.lower()) and "401" not in l]
print("\n".join(errs) or "(aucune erreur console hors 401 attendus)")
