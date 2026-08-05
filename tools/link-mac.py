#!/usr/bin/env python3
"""Give this Mac an identity in the `narew-labs` project, and fill the hole it
leaves in the database rules.

`firebase/database.rules.json` names one uid four times, and ships with the
literal string `MAC_UID_PLACEHOLDER` in each place. Until that is replaced,
nobody can write `status/mac` and nobody can write `open/*/out` — which means
the sidebar never says the Mac is awake and no answer ever streams back. The
app is not broken in that state; it is unlinked.

The asymmetry is deliberate and is explained in
`AIe/G-Micro/database.rules.md`: browsers may write jobs into their own
unguessable subtree, and exactly one account — this Mac — may list the tree and
answer. That privilege has to be attached to a uid, so the Mac signs in once,
anonymously, and keeps the account alive with its refresh token.

What this script does:

  1. Signs in anonymously to `narew-labs` (or reuses the identity it already
     wrote) and stores {uid, refresh_token} in ~/.narew-labs/identity.json,
     chmod 600. Deliberately a different file from G-Micro's
     ~/.g-micro/identity.json — that one is a working account in a different
     Firebase project, and overwriting it would unlink G-Micro.
  2. Writes firebase/database.rules.local.json — the same rules with the real
     uid substituted — and prints the exact deploy command.

Why the uid does not go into the repo: it is not a secret (it grants nothing on
its own; the refresh token in identity.json is what actually authenticates), but
it is a permanent, machine-specific identifier that would sit in public git
history forever and would have to be rewritten there every time the identity
file is lost. Keeping it in an ignored local file means the repo stays honest
about the fact that a placeholder is what is committed.

Standard library only. Run:

    python3 tools/link-mac.py              # sign in if needed, write local rules
    python3 tools/link-mac.py --status     # report only, never creates an account
    python3 tools/link-mac.py --print-uid  # the uid, if there already is one
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = "narew-labs"

# The same public web config as js/firebase.js. An API key identifies the
# project to Google's endpoints; it authorises nothing on its own.
API_KEY = "AIzaSyCiNb3wGWfE1xt19CmeEF3M4hh2KQ_QcqM"

SIGNUP_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}"
REFRESH_URL = f"https://securetoken.googleapis.com/v1/token?key={API_KEY}"

IDENTITY = Path.home() / ".narew-labs" / "identity.json"

REPO = Path(__file__).resolve().parents[1]
RULES_SRC = REPO / "firebase" / "database.rules.json"
RULES_OUT = REPO / "firebase" / "database.rules.local.json"

PLACEHOLDER = "MAC_UID_PLACEHOLDER"

AUTH_CONSOLE = f"https://console.firebase.google.com/project/{PROJECT}/authentication/providers"


class Failed(Exception):
    """Something the user can act on. Printed as a sentence, not a traceback."""


def post_json(url, payload=None, form=None):
    if form is not None:
        import urllib.parse
        data, ctype = urllib.parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
    else:
        data, ctype = json.dumps(payload or {}).encode(), "application/json"
    req = urllib.request.Request(url, data=data, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(body)["error"]["message"]
        except Exception:
            message = body[:300]
        raise Failed(explain(message))
    except urllib.error.URLError as e:
        raise Failed(f"Brak połączenia z Firebase: {e.reason}")


def explain(message):
    """Turn Google's error string into the thing that actually needs doing."""
    if "ADMIN_ONLY_OPERATION" in message or "admin-restricted" in message:
        return (
            "Logowanie anonimowe nie jest włączone w tym projekcie, więc Mac nie może\n"
            "  założyć sobie konta.\n\n"
            f"  Włącz je tutaj:  {AUTH_CONSOLE}\n"
            "  Authentication -> Sign-in method -> Anonymous -> Enable.\n"
            "  Potem odpal ten skrypt jeszcze raz."
        )
    if "CONFIGURATION_NOT_FOUND" in message:
        return (
            "Authentication nie jest jeszcze uruchomione w tym projekcie.\n\n"
            f"  Wejdź tutaj i kliknij Get started:  {AUTH_CONSOLE}\n"
            "  Włącz Google i Anonymous, potem odpal ten skrypt jeszcze raz."
        )
    if "TOKEN_EXPIRED" in message or "INVALID_REFRESH_TOKEN" in message or "USER_NOT_FOUND" in message:
        return (
            f"Zapisana tożsamość Maca jest nieważna (Firebase mówi: {message}).\n"
            f"  Skasuj {IDENTITY} i odpal skrypt ponownie — powstanie nowy uid,\n"
            "  więc reguły trzeba będzie wdrożyć jeszcze raz."
        )
    return f"Firebase odmówił: {message}"


# ---------------------------------------------------------------- identity --

def load_identity():
    if not IDENTITY.exists():
        return None
    try:
        saved = json.loads(IDENTITY.read_text())
    except (OSError, ValueError) as e:
        raise Failed(f"Nie mogę odczytać {IDENTITY}: {e}")
    if not saved.get("uid") or not saved.get("refresh_token"):
        raise Failed(f"{IDENTITY} istnieje, ale nie ma w nim uid i refresh_token. Skasuj go i odpal ponownie.")
    return saved


def save_identity(uid, refresh_token):
    IDENTITY.parent.mkdir(parents=True, exist_ok=True)
    # Same shape as MacIdentity in AIe/G-Micro/runtime/bridge.py, so a bridge
    # pointed at this project can read it without any new code.
    IDENTITY.write_text(json.dumps({"uid": uid, "refresh_token": refresh_token}, indent=2))
    IDENTITY.chmod(0o600)


def ensure_identity():
    """The Mac's uid, creating the account only when there is not one already."""
    saved = load_identity()
    if saved:
        # Prove the stored token still works, and let Firebase confirm the uid.
        d = post_json(REFRESH_URL, form={
            "grant_type": "refresh_token",
            "refresh_token": saved["refresh_token"],
        })
        uid = d.get("user_id", saved["uid"])
        if uid != saved["uid"]:
            save_identity(uid, d.get("refresh_token", saved["refresh_token"]))
        print(f"  = tożsamość już istnieje: {IDENTITY}")
        print(f"  = uid Maca: {uid}")
        return uid

    d = post_json(SIGNUP_URL, payload={"returnSecureToken": True})
    uid, refresh = d["localId"], d["refreshToken"]
    save_identity(uid, refresh)
    print(f"  + założono konto anonimowe, zapisane w {IDENTITY} (chmod 600)")
    print(f"  + uid Maca: {uid}")
    return uid


# ------------------------------------------------------------------- rules --

def write_local_rules(uid):
    if not RULES_SRC.exists():
        raise Failed(f"Nie znajduję {RULES_SRC}.")
    text = RULES_SRC.read_text()
    hits = text.count(PLACEHOLDER)
    if hits == 0 and uid not in text:
        raise Failed(
            f"W {RULES_SRC.name} nie ma ani {PLACEHOLDER}, ani tego uid — "
            "ktoś zmienił reguły. Sprawdź je ręcznie."
        )
    RULES_OUT.write_text(text.replace(PLACEHOLDER, uid))
    print(f"  + {RULES_OUT.relative_to(REPO)} — {hits} podmian(y) {PLACEHOLDER} -> uid")
    return hits


def print_next_steps():
    print()
    print("Zostało jedno polecenie — wdrożenie reguł z prawdziwym uid:")
    print()
    print(f"    cd {REPO} && \\")
    print(f"      firebase deploy --only database --project {PROJECT} \\")
    print(f"      --config <(python3 -c \"import json;print(json.dumps({{'database':{{'rules':'firebase/database.rules.local.json'}}}}))\")")
    print()
    print("Jeśli to za dużo naraz — prostszy wariant: podmień w firebase.json")
    print("  \"database\": { \"rules\": \"firebase/database.rules.local.json\" }")
    print(f"na czas wdrożenia, odpal  firebase deploy --only database --project {PROJECT},")
    print("i przywróć plik z powrotem.")
    print()
    print("Do repo NIE wrzucaj database.rules.local.json — wersja z placeholderem")
    print("zostaje w gicie, żeby było widać, że uid jest lokalny.")


# -------------------------------------------------------------------- main --

def status():
    saved = None
    try:
        saved = load_identity()
    except Failed as e:
        print(f"  ! {e}")
    print(f"Projekt:    {PROJECT}")
    print(f"Tożsamość:  {IDENTITY}  {'jest' if saved else 'BRAK'}")
    if saved:
        print(f"uid Maca:   {saved['uid']}")
    src = RULES_SRC.read_text() if RULES_SRC.exists() else ""
    n = src.count(PLACEHOLDER)
    print(f"Reguły:     {RULES_SRC.relative_to(REPO)} — {n} x {PLACEHOLDER}")
    print(f"Lokalne:    {RULES_OUT.relative_to(REPO)}  {'jest' if RULES_OUT.exists() else 'BRAK'}")
    if n:
        print()
        print("  Dopóki placeholder siedzi we WDROŻONYCH regułach, Mac nie zapisze")
        print("  status/mac ani open/*/out — czyli brak obecności i brak odpowiedzi.")


def main():
    p = argparse.ArgumentParser(
        description="Podłącza tego Maca do projektu narew-labs i przygotowuje reguły bazy."
    )
    p.add_argument("--status", action="store_true",
                   help="tylko raport; nigdy nie zakłada konta")
    p.add_argument("--print-uid", action="store_true",
                   help="wypisz zapisany uid i zakończ (nie zakłada konta)")
    args = p.parse_args()

    try:
        if args.print_uid:
            saved = load_identity()
            if not saved:
                raise Failed(f"Nie ma jeszcze tożsamości ({IDENTITY}). Odpal skrypt bez flag.")
            print(saved["uid"])
            return

        if args.status:
            status()
            return

        print(f"Projekt: {PROJECT}\n")
        uid = ensure_identity()
        write_local_rules(uid)
        print_next_steps()
    except Failed as e:
        print(f"\nNie udało się: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
