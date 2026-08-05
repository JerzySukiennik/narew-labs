#!/usr/bin/env python3
"""Create the Firestore documents the app needs but never writes itself.

Some documents are read by the client and written by nobody: `promoCodes/*` is
readable by any signed-in user and closed to every client write (see
`firebase/firestore.rules`), so a code that is not in the database is simply a
code that does not exist. Clicking one into the console works once and is then
undocumented and unreproducible — this script is the repeatable version.

It is idempotent by design: every document is written with PATCH on its own
path, so running it on a fresh project and on a project where Jurek already
made the document by hand both end in the same state.

Authentication borrows the firebase CLI's own OAuth token
(`~/.config/configstore/firebase-tools.json`), so there is no service-account
key to create or to keep. The client id/secret below are the ones compiled into
firebase-tools — a public desktop-app client, not a secret of this project.

Standard library only. Run:

    python3 tools/seed-firestore.py           # write what is missing or stale
    python3 tools/seed-firestore.py --dry-run # say what it would do, write nothing
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = "narew-labs"
CONFIGSTORE = Path.home() / ".config" / "configstore" / "firebase-tools.json"

# Built into the firebase CLI and shipped in every copy of it. A desktop OAuth
# client cannot keep a secret, which is why Google does not treat this as one.
CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
TOKEN_URL = "https://oauth2.googleapis.com/token"

BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"

# What the app expects to find. Path -> plain Python dict; the Firestore value
# encoding is applied below so this table stays readable.
#
# The promo code is the only way to reach a paid tier without pretending money
# changed hands: the checkout in `js/views/upgrade.js` is openly a prop, so a
# code Jurek hands out is the real grant path. Lower-case, because
# `store.redeemPromo` lower-cases whatever is typed before looking it up.
SEEDS = {
    "promoCodes/gzowojestnajlepsze": {"tier": "sum", "active": True},
}


class Failed(Exception):
    """Something the user can act on. Printed as a sentence, not a traceback."""


# ------------------------------------------------------------------- auth --

def access_token():
    """A fresh Google access token, borrowed from the logged-in firebase CLI."""
    if not CONFIGSTORE.exists():
        raise Failed(
            f"Nie znajduję poświadczeń firebase CLI ({CONFIGSTORE}).\n"
            "Zaloguj się:  firebase login"
        )
    try:
        tokens = json.loads(CONFIGSTORE.read_text()).get("tokens") or {}
    except (OSError, ValueError) as e:
        raise Failed(f"Nie mogę odczytać {CONFIGSTORE}: {e}")

    refresh = tokens.get("refresh_token")
    if not refresh:
        raise Failed(
            "Plik firebase CLI nie ma refresh tokenu — CLI nie jest zalogowane.\n"
            "Zaloguj się:  firebase login"
        )

    # The stored access_token usually expired hours ago; refreshing is cheap and
    # removes a whole class of "worked yesterday" failures.
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(TOKEN_URL, data=body), timeout=30
        ) as r:
            return json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        raise Failed(
            "Google odrzucił refresh token firebase CLI "
            f"(HTTP {e.code}). Zaloguj się jeszcze raz:  firebase login --reauth"
        )
    except urllib.error.URLError as e:
        raise Failed(f"Brak połączenia z Google: {e.reason}")


# -------------------------------------------------------------- firestore --

def encode(value):
    """Python value -> Firestore REST `Value`. Only what SEEDS actually uses."""
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if value is None:
        return {"nullValue": None}
    return {"stringValue": str(value)}


def decode(value):
    """The inverse, so an existing document can be compared with the wanted one."""
    if "booleanValue" in value:
        return value["booleanValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "nullValue" in value:
        return None
    return value.get("stringValue")


def call(method, path, token, payload=None, params=None):
    url = f"{BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == "GET":
            return None
        detail = e.read().decode("utf-8", "replace")[:400]
        raise Failed(f"Firestore odrzucił {method} {path} (HTTP {e.code}):\n{detail}")
    except urllib.error.URLError as e:
        raise Failed(f"Brak połączenia z Firestore: {e.reason}")


def existing_fields(doc):
    return {k: decode(v) for k, v in (doc.get("fields") or {}).items()} if doc else None


def seed(dry_run=False, force=False):
    token = access_token()
    changed = 0

    for path, wanted in SEEDS.items():
        current = existing_fields(call("GET", path, token))

        # Only the keys this script owns are compared. A field somebody added by
        # hand in the console (a note to self, say) is none of our business and
        # must survive — hence the updateMask on the write below.
        if not force and current is not None and all(current.get(k) == v for k, v in wanted.items()):
            extra = {k: v for k, v in current.items() if k not in wanted}
            note = f"  (+ pola spoza skryptu: {extra})" if extra else ""
            print(f"  = {path}  już zgodny {wanted}{note}")
            continue

        verb = "tworzę" if current is None else ("zapisuję ponownie" if force else "poprawiam")
        if current is not None:
            print(f"  ! {path}  było {current}")
        if dry_run:
            print(f"  ~ {path}  {verb} -> {wanted}  (dry-run, nic nie zapisuję)")
            continue

        # PATCH on the full document path creates it when absent and updates it
        # when present — one call, same result either way. updateMask limits the
        # write to the fields listed here, so nothing else in the document is
        # touched or deleted.
        call("PATCH", path, token,
             payload={"fields": {k: encode(v) for k, v in wanted.items()}},
             params={"updateMask.fieldPaths": list(wanted)})
        print(f"  + {path}  {verb} -> {wanted}")
        changed += 1

    print()
    if dry_run:
        print("Dry-run — nic nie zapisano.")
    elif changed:
        print(f"Gotowe: zapisano {changed} dokument(y). Skrypt można odpalać wielokrotnie.")
    else:
        print("Gotowe: wszystko już było na miejscu.")


def main():
    p = argparse.ArgumentParser(
        description="Zakłada w Firestore dokumenty, których nie tworzy żaden kod aplikacji."
    )
    p.add_argument("--dry-run", action="store_true",
                   help="pokaż, co by się zmieniło, i nic nie zapisuj")
    p.add_argument("--force", action="store_true",
                   help="zapisz nawet to, co już jest zgodne (do sprawdzenia dostępu)")
    args = p.parse_args()

    print(f"Projekt: {PROJECT}\n")
    try:
        seed(dry_run=args.dry_run, force=args.force)
    except Failed as e:
        print(f"\nNie udało się: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
