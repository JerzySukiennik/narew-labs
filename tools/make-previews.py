#!/usr/bin/env python3
"""Generate the Image Studio preset previews by actually running the model.

The cards in Image Studio should show what an edit does. Drawing an
approximation is easy and slightly dishonest; running the real checkpoint and
shipping its output is the only version that cannot mislead. This script does
the second one.

It talks to the same Realtime Database bridge the browser uses — a job goes into
`open/<client>/jobs`, the Mac picks it up and writes the result to
`open/<client>/out/<jobId>` — so it needs nothing the app does not already need:
no service account, no Firebase Admin SDK, no secrets. Writing a job is open to
anyone who knows a client id, and reading `out` only needs the path.

    python3 tools/make-previews.py                 # every preset, current model
    python3 tools/make-previews.py --model g-image-1
    python3 tools/make-previews.py --only mono,old

Results land in `assets/previews/<model>/<look>.jpg` next to `base.jpg`, and
`js/views/image.js` picks them up automatically once they exist.

Requires the Mac bridge to be *consuming* jobs, not merely publishing a
heartbeat. Those are two different things and only the first one produces
pictures — run --check first if nothing comes back.
"""

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DB = "https://narew-labs-default-rtdb.europe-west1.firebasedatabase.app"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "previews"

# The client id is fixed rather than random so repeated runs reuse one subtree
# instead of littering the database with abandoned ones. It still satisfies the
# rules' 20-character minimum.
CLIENT = "narewlabspreviewbuilder01"

# Must match PRESETS in js/views/image.js — the `look` is the filename.
PRESETS = [
    ("mono", "zrób to czarno-białe"),
    ("pencil", "zamień na rysunek ołówkiem"),
    ("winter", "dodaj śnieg"),
    ("old", "zrób to jak stara fotografia"),
    ("bright", "rozjaśnij zdjęcie"),
    ("dusk", "zrób ciepłe światło zachodu"),
]

# The database rules cap an image at 400 000 characters of data URL.
MAX_CHARS = 400_000


def api(path, payload=None, method="GET"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{DB}/{path}.json", data=data,
        headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def mac_status():
    """What the Mac says about itself, and how long ago it said it."""
    try:
        s = api("status/mac") or {}
    except urllib.error.URLError as e:
        return None, f"nie mogę odpytać bazy: {e.reason}"
    if not s:
        return None, "status/mac jest pusty — most nigdy się nie odezwał"
    age = (time.time() * 1000 - s.get("at", 0)) / 1000
    if not s.get("online") or age > 70:
        return s, f"most milczy od {age:.0f} s — Mac śpi albo proces nie działa"
    return s, ""


def load_base(path):
    raw = path.read_bytes()
    url = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    if len(url) > MAX_CHARS:
        sys.exit(f"Zdjęcie bazowe jest za duże ({len(url)} znaków, limit {MAX_CHARS}). "
                 "Zmniejsz je przed uruchomieniem.")
    return url


def run_one(model, prompt, image_url, timeout):
    """Post one job and wait for the picture. Returns bytes or raises."""
    job = api(f"open/{CLIENT}/jobs",
              {"model": model, "text": prompt, "image": image_url,
               "at": int(time.time() * 1000)}, "POST")
    jid = job["name"]

    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        time.sleep(2)
        out = api(f"open/{CLIENT}/out/{jid}")
        if not out:
            continue
        if isinstance(out.get("progress"), (int, float)):
            shown = f"{out['progress'] * 100:.0f}%"
            if shown != last:
                print(f"      {shown}", end="\r", flush=True)
                last = shown
        if out.get("done"):
            if out.get("image"):
                return base64.b64decode(out["image"].split(",", 1)[1])
            raise RuntimeError(out.get("text") or "model nie zwrócił obrazka")
    raise TimeoutError(f"brak odpowiedzi w {timeout} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="g-images",
                    help="nazwa modelu na drucie (domyślnie g-images)")
    ap.add_argument("--base", default=str(OUT_DIR / "base.jpg"),
                    help="zdjęcie wejściowe")
    ap.add_argument("--only", help="tylko te presety, po przecinku (np. mono,old)")
    ap.add_argument("--timeout", type=int, default=300,
                    help="ile sekund czekać na jedną przeróbkę")
    ap.add_argument("--check", action="store_true",
                    help="tylko sprawdź, czy most odpowiada, i wyjdź")
    args = ap.parse_args()

    status, problem = mac_status()
    if problem:
        print(f"Most: {problem}")
        if not args.check:
            print("Nic nie wygeneruję — najpierw uruchom most na Macu.")
        return 1
    names = [m.get("id") for m in (status.get("models") or [])]
    print(f"Most żyje. Publikuje: {', '.join(names) or '(nic)'}")
    if args.model not in names:
        print(f"UWAGA: {args.model} nie jest na tej liście — zadania nie zostaną obsłużone.")
        if not args.check:
            return 1
    if args.check:
        return 0

    base = Path(args.base)
    if not base.exists():
        sys.exit(f"Brak zdjęcia bazowego: {base}")
    image_url = load_base(base)

    wanted = set(args.only.split(",")) if args.only else None
    target = OUT_DIR / args.model
    target.mkdir(parents=True, exist_ok=True)

    made, failed = 0, 0
    for look, prompt in PRESETS:
        if wanted and look not in wanted:
            continue
        print(f"  {look:8} „{prompt}”")
        try:
            data = run_one(args.model, prompt, image_url, args.timeout)
        except Exception as e:                      # noqa: BLE001 — reported, not swallowed
            print(f"      NIE UDAŁO SIĘ: {e}")
            failed += 1
            continue
        (target / f"{look}.jpg").write_bytes(data)
        print(f"      zapisane ({len(data) // 1024} kB)")
        made += 1

    print(f"\nGotowe: {made} podglądów w {target.relative_to(ROOT)}"
          + (f", {failed} nieudanych" if failed else ""))
    return 1 if failed and not made else 0


if __name__ == "__main__":
    sys.exit(main())
