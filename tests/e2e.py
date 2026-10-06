"""End-to-end test of the Reco web app (Edge with a fake camera, microphone and screen).

1. `npx wrangler dev --port 8787 --local` (with INVITE_CODE=test-local-123 in .dev.vars)
2. python tests/e2e.py [mode] [seconds]     mode = screen+cam (default) | screen | cam
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
    print(("OK   " if cond else "FAIL ") + msg, flush=True)
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
    login(pg, "Alex", "wrong")
    pg.wait_for_function("document.querySelector('#l-err').textContent.length > 0")
    check("Wrong invite code" in pg.inner_text("#l-err"), "wrong code rejected")
    pg.fill("#l-code", "test-local-123"); pg.click("#f-login button")
    pg.wait_for_selector("#v-lib:not([hidden])")
    check(True, "sign-in and library")

    # ── recording with continuous upload ──
    pg.click("#b-new"); pg.wait_for_selector("#v-setup:not([hidden])")
    pg.click(f'.mode[data-mode="{MODE}"]'); pg.click("#b-prepare")
    pg.wait_for_selector("#b-go:not([hidden])", timeout=15000)
    pg.wait_for_function("document.querySelector('#pv').videoWidth > 0", timeout=15000)
    wh = pg.evaluate("[document.querySelector('#pv').videoWidth, document.querySelector('#pv').videoHeight]")
    check(True, f"composited preview {wh[0]}x{wh[1]}")
    pg.click("#b-go"); pg.wait_for_selector("#v-rec:not([hidden])")
    time.sleep(2.6 + SECS - 3)
    pg.click("#r-pause"); time.sleep(1.5); pg.click("#r-pause"); time.sleep(3)
    sent, inflight, local = pg.evaluate("[R.up ? R.up.parts.length : -1, R.up && R.up.busy ? 1 : 0, R.localSize]")
    expected = int(local // (8 * 1024 * 1024))
    check(sent + inflight >= expected, f"{local / 1e6:.1f} MB recorded: {sent} chunk(s) already online + {inflight} in flight BEFORE stopping (expected {expected})")
    pg.click("#r-stop")
    pg.wait_for_selector("#x-share:not([hidden])", timeout=60000)
    link = pg.input_value("#x-link"); vid = link.rsplit("/", 1)[-1]
    check("/v/" in link and "Ready" in pg.inner_text("#x-status"), f"link ready as soon as it stops: {link}")
    # title + trim (start at 2 s)
    pg.fill("#x-title", f"Test e2e {MODE}")
    pg.wait_for_selector("#x-trim:not([hidden])")
    pg.evaluate("const s=document.querySelector('#x-ts'); s.value=2; s.dispatchEvent(new Event('input'))")
    pg.click("#x-done"); pg.wait_for_selector("#v-lib:not([hidden])")
    html = http(f"/v/{vid}")[2].decode()
    check(f"Test e2e {MODE}" in html and "#t=2" in html, "title and trim saved (playback starts at 2 s)")

    # ── public playback + view counter (signed-out tab) ──
    pub = b.new_context().new_page()
    pub.goto(link)
    pub.wait_for_function("document.querySelector('#pv').readyState >= 1", timeout=15000)
    pub.evaluate("document.querySelector('#pv').play()"); time.sleep(2)
    t_now = pub.evaluate("document.querySelector('#pv').currentTime")
    check(t_now >= 2, f"the player starts after the trim (t = {t_now:.1f} s)")
    pg.reload(); pg.wait_for_selector(f'.vc[data-id="{vid}"]')
    check("1 view" in pg.inner_text(f'.vc[data-id="{vid}"]'), "view counter: 1 view")

    # ── importing a file > 8 MB (several chunks) ──
    src = OUT / "import.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=12", "-f", "lavfi", "-i", "sine=f=440:duration=12",
                    "-c:v", "libx264", "-b:v", "12M", "-c:a", "aac", "-shortest", str(src)], check=True)
    pg.set_input_files("#f-import", str(src))
    pg.wait_for_selector("#x-share:not([hidden])", timeout=60000)
    ivid = pg.input_value("#x-link").rsplit("/", 1)[-1]
    st, hd, body = http(f"/f/{ivid}")
    check(st == 200 and len(body) == src.stat().st_size, f"import of {src.stat().st_size / 1e6:.1f} MB reassembled byte for byte")
    check(http(f"/t/{ivid}")[0] == 200, "thumbnail generated for the import")
    pg.click("#x-done"); pg.wait_for_selector("#v-lib:not([hidden])")

    # ── another user cannot delete ──
    other = b.new_context().new_page(); login(other, "Sam"); other.wait_for_selector("#v-lib:not([hidden])")
    r = other.evaluate(f"fetch('/api/videos/{vid}',{{method:'DELETE'}}).then(r=>r.status)")
    check(r == 403, "another user cannot delete the video (403)")
    check(other.locator(f'.vc[data-id="{vid}"] [data-act="del"]').count() == 0, "and is not offered the Delete button")
    b.close()

# ── checks on the recorded file ──
st, hd, body = http(f"/f/{vid}", headers={"Range": "bytes=0-1023"})
check(st == 206 and len(body) == 1024, "partial playback (Range 206)")
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
check(abs(real_s - SECS) < 1.5, f"actual duration {real_s:.1f} s for {SECS:.0f} s recorded (pause excluded), file assembled from the chunks")
errs = [l for l in logs if ("error" in l.lower() or "warn" in l.lower()) and "401" not in l]
print("\n".join(errs) or "(no console errors apart from the expected 401s)")
