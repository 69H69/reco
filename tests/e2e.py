"""Test de bout en bout de Reco (Chrome avec caméra, micro et écran factices).

Lancer `npx wrangler dev --port 8787 --local`, puis : python tests/e2e.py [mode]
mode = screen+cam (défaut) | screen | cam
"""
import json, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"
MODE = sys.argv[1] if len(sys.argv) > 1 else "screen+cam"
OUT = Path(tempfile.gettempdir()) / "reco-e2e"
OUT.mkdir(exist_ok=True)


def check(cond, msg):
    print(("OK   " if cond else "ÉCHEC ") + msg)
    if not cond:
        sys.exit(1)


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge", headless=True, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(permissions=["camera", "microphone", "clipboard-read", "clipboard-write"], viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.goto(f"{BASE}/?fakeScreen=1")
    pg.fill("#l-name", "Alex"); pg.fill("#l-code", "mauvais"); pg.click("#f-login button")
    pg.wait_for_function("document.querySelector('#l-err').textContent.length > 0")
    check("incorrect" in pg.inner_text("#l-err"), "mauvais code refusé")
    pg.fill("#l-code", "test-local-123"); pg.click("#f-login button")
    pg.wait_for_selector("#v-lib:not([hidden])")
    check(True, "connexion et bibliothèque")
    pg.click("#b-new"); pg.wait_for_selector("#v-setup:not([hidden])")
    pg.click(f'.mode[data-mode="{MODE}"]')
    pg.click("#b-prepare")
    pg.wait_for_selector("#b-go:not([hidden])", timeout=15000)
    pg.wait_for_function("document.querySelector('#pv').videoWidth > 0", timeout=15000)
    vw = pg.evaluate("[document.querySelector('#pv').videoWidth, document.querySelector('#pv').videoHeight]")
    check(vw[0] > 0, f"aperçu composé actif {vw[0]}x{vw[1]}")
    pg.click("#b-go")
    pg.wait_for_selector("#v-rec:not([hidden])")
    time.sleep(2.6 + 4.0)  # compte à rebours + 4 s d'enregistrement
    pg.click("#r-pause"); time.sleep(1.5); pg.click("#r-pause"); time.sleep(1.5)
    t = pg.inner_text("#r-time")
    check(t in ("0:05", "0:06"), f"chrono hors pause = {t} (attendu ≈ 0:05)")
    pg.click("#r-stop")
    pg.wait_for_selector("#v-review:not([hidden])", timeout=15000)
    pg.fill("#x-title", f"Test e2e {MODE}")
    pg.click("#x-up")
    pg.wait_for_selector("#x-share:not([hidden])", timeout=60000)
    link = pg.input_value("#x-link")
    check("/v/" in link, f"envoi terminé, lien = {link}")
    vid = link.rsplit("/", 1)[-1]
    pg.goto(link)
    check(f"Test e2e {MODE}" in pg.title(), "page de partage avec le titre")
    og = pg.eval_on_selector('meta[property="og:image"]', "e => e.content")
    check(og.endswith(f"/t/{vid}"), "aperçu WhatsApp (og:image)")
    pg.wait_for_function("document.querySelector('#pv').readyState >= 1", timeout=15000)
    check(True, "la vidéo se charge dans le lecteur partagé")
    b.close()

# ── contrôles HTTP et fichier ──
req = urllib.request.Request(f"{BASE}/f/{vid}", headers={"Range": "bytes=0-1023"})
with urllib.request.urlopen(req) as r:
    check(r.status == 206 and len(r.read()) == 1024 and r.headers["content-range"].startswith("bytes 0-1023/"), "lecture partielle (Range 206) pour l'avance rapide")
with urllib.request.urlopen(f"{BASE}/t/{vid}") as r:
    check(r.status == 200 and r.headers["content-type"] == "image/jpeg", "miniature disponible")
    (OUT / f"{vid}.jpg").write_bytes(r.read())
with urllib.request.urlopen(f"{BASE}/f/{vid}") as r:
    ext = "mp4" if "mp4" in r.headers["content-type"] else "webm"
    f = OUT / f"{vid}.{ext}"; f.write_bytes(r.read())
info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
                                  "-of", "json", str(f)], capture_output=True, text=True).stdout)
kinds = {s["codec_type"]: s for s in info["streams"]}
check("video" in kinds and "audio" in kinds, f"fichier {ext} avec image ({kinds['video']['codec_name']}) et son ({kinds.get('audio', {}).get('codec_name')})")
# durée réelle (le webm de MediaRecorder n'a pas toujours la durée en en-tête : on décode)
dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-map", "0:v", "-f", "null", "-", "-stats"], capture_output=True, text=True).stderr
tm = [x for x in dec.replace("\r", "\n").split("\n") if "time=" in x]
real = tm[-1].split("time=")[1].split()[0] if tm else "?"
check(real.startswith("00:00:05") or real.startswith("00:00:06"), f"durée réelle {real} (≈ 5-6 s, pause exclue)")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "2", "-i", str(f), "-frames:v", "1", str(OUT / f"{vid}_frame.jpg")])
print("Image extraite :", OUT / f"{vid}_frame.jpg")
print("\n".join(l for l in logs if "error" in l.lower() or "warn" in l.lower()) or "(aucune erreur console)")
