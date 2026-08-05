# Narew Labs

Jedna strona nad modelami rodziny G — chat z G-Micro i G-Mini, Image Studio nad
G-Images, konto z tierami i historią rozmów. Modele nie działają w przeglądarce
ani na żadnym serwerze: liczy je Mac w domu, a strona i Mac spotykają się przez
Realtime Database (strona wrzuca zadanie, Mac dopisuje rosnącą odpowiedź).
Dokładnie ten sam mechanizm, na którym już działa G-Micro. Kiedy Mac śpi,
aplikacja mówi to wprost, zamiast udawać, że się zastanawia.

---

## 1. Firebase — co jest wyklikane, a co nie

Konsola projektu: <https://console.firebase.google.com/project/narew-labs>

**Sprawdzone 2026-08-05 i już zrobione:**

| Rzecz | Stan |
|---|---|
| Firestore | jest, reguły z `firebase/firestore.rules` wdrożone |
| Realtime Database (`europe-west1`) | jest, reguły wdrożone — ale z placeholderem, patrz §2 |
| Authentication → Google | **włączone** |
| Authentication → Anonymous | **włączone** (obsługuje i gościa w apce, i logowanie Maca) |
| Authorized domains | `localhost`, `narew-labs.firebaseapp.com`, `narew-labs.web.app` |

**Co zostało do wyklikania:**

- **Dodaj domenę produkcyjną do Authorized domains**, kiedy już zapadnie decyzja,
  pod jakim adresem to stoi (patrz §6).
  → <https://console.firebase.google.com/project/narew-labs/authentication/settings>
  → Authorized domains → Add domain.
  Bez tego logowanie przez Google na tej domenie zwróci `auth/unauthorized-domain`.
  Aplikacja to nazwie po imieniu („Ta domena nie jest dopuszczona w Firebase Auth"),
  ale przycisk po prostu nie zadziała. `localhost` jest już na liście, więc lokalnie
  działa od ręki.

- **Wyłącz Email/Password**, jeśli chcesz porządku. Jest włączone, a aplikacja
  nigdy z niego nie korzysta — `js/firebase.js` zna wyłącznie Google i Anonymous.
  Nic nie psuje, po prostu wisi.

Gdyby ktoś kiedyś wyłączył Anonymous: wejście jako gość i logowanie Maca przestają
działać, a apka pokaże „Wejście jako gość nie jest włączone w konsoli Firebase".

---

## 2. Podłączenie Maca ⚠️

**To jest jedyna rzecz, która dziś naprawdę blokuje działanie.**

`firebase/database.rules.json` w czterech miejscach nazywa uid Maca literalnym
napisem `MAC_UID_PLACEHOLDER`. Takie reguły są **wdrożone**. Skutek:

- nikt nie może zapisać `status/mac` → pasek w sidebarze nigdy nie powie „most żyje",
- nikt nie może zapisać `open/*/out` → **żadna odpowiedź nie wróci**, ani w chacie,
  ani w Image Studio.

Zadania z przeglądarki się zapisują. Po prostu nie ma komu odpowiedzieć.

Naprawa:

```
python3 tools/link-mac.py
```

Skrypt:
1. loguje Maca anonimowo w `narew-labs` i zapisuje `{uid, refresh_token}` do
   `~/.narew-labs/identity.json` (chmod 600) — **osobny plik** od `~/.g-micro/identity.json`,
   żeby nie rozwalić działającej tożsamości G-Micro;
2. jest idempotentny — jak plik już jest, używa zapisanego uid zamiast zakładać drugie konto;
3. wypisuje `firebase/database.rules.local.json`: te same reguły z prawdziwym uid;
4. wypisuje dokładne polecenie `firebase deploy`, którym to wdrożysz.

Tryby, które **nic nie zakładają i nic nie zapisują**:

```
python3 tools/link-mac.py --status      # raport: czy jest tożsamość, ile placeholderów
python3 tools/link-mac.py --print-uid   # sam uid, jeśli już istnieje
```

`database.rules.local.json` **nie idzie do repo**. Uid sam w sobie nie jest sekretem
— to tylko identyfikator, nic nie otwiera; dostęp daje refresh token z `identity.json`.
Ale to trwały identyfikator konkretnej maszyny, który w publicznej historii gita
zostałby na zawsze i trzeba by go tam przepisywać po każdej utracie pliku tożsamości.
W gicie zostaje wersja z placeholderem, żeby było widać, że uid jest lokalny.

**Utrata `~/.narew-labs/identity.json` = nowy uid = reguły trzeba wdrożyć jeszcze raz.**

Sam most (proces, który czyta zadania i liczy odpowiedzi) to `runtime/bridge.py`
z projektu G-Micro. Na dziś celuje w bazę `g-micro-web`; przestawienie go na
`narew-labs` to osobna robota, poza tym repo.

---

## 3. Firestore — dokumenty, których nie tworzy żaden kod

```
python3 tools/seed-firestore.py
```

`promoCodes/*` są w regułach czytelne dla zalogowanych i **zamknięte na zapis
z klienta** — kod, którego nie ma w bazie, po prostu nie istnieje. Aplikacja go
nigdy nie założy. Skrypt zakłada `promoCodes/gzowojestnajlepsze` = `{tier: "sum",
active: true}` i jest bezpieczny przy powtórzeniu: porównuje, pisze z `updateMask`,
więc pola dopisane ręcznie w konsoli przeżywają.

```
python3 tools/seed-firestore.py --dry-run   # powiedz, co byś zrobił, nie zapisuj
python3 tools/seed-firestore.py --force     # zapisz też to, co już zgodne
```

Uwierzytelnia się tokenem OAuth zalogowanego `firebase` CLI
(`~/.config/configstore/firebase-tools.json`) — nie ma żadnego klucza service
account do wyklikania ani trzymania.

---

## 4. Lokalnie

```
python3 tools/devserver.py
```

Potem <http://127.0.0.1:8141>. Port można podać jako pierwszy argument.
Zwykły `http.server` nie wystarcza: pozwala przeglądarce cache'ować moduły ES
przez edycję, co czyta się jako „moja poprawka nic nie dała". Ten serwer wysyła
`no-store`.

`localhost` jest już w Authorized domains, więc logowanie Google działa lokalnie
bez dodatkowych kroków.

---

## 5. Mapa plików

**Korzeń** — `index.html` to cały szkielet: sidebar, topbar i siedem pustych
`<section>`, które widoki wypełniają w locie. `404.html` istnieje, bo GitHub Pages
nie ma routingu serwerowego — zamienia `/r/<uid>` na `/?ref=<uid>` i wszystko inne
odsyła na stronę główną. `CNAME` trzyma domenę (patrz §6).

**`js/`** — `firebase.js` to jedyne miejsce, które wie o Firebase: konfiguracja,
logowanie i tłumaczenie błędów Firebase na zdania po polsku. `store.js` to konto —
profil, tier, zużycie, polecenia, historia; widoki subskrybują, nigdy nie piszą do
Firestore same. `bridge.js` to przeglądarkowy koniec mostu do Maca. `main.js`
routuje po hashu i skleja to razem, `ui.js` trzyma drobiazgi (toasty, overlaye,
animacje). `js/views/` to po jednym pliku na ekran.

**`css/`** — `tokens.css` (zmienne), `base.css`, `shell.css` (sidebar/topbar),
`chat.css`, `studio.css`, `panels.css`.

**`firebase/`** — `firestore.rules` i `database.rules.json`. Realtime Database nie
przyjmuje komentarzy w regułach, więc uzasadnienie ich kształtu mieszka w
`AIe/G-Micro/database.rules.md` — warto przeczytać przed jakąkolwiek zmianą.

**`tools/`** — `devserver.py`, `seed-firestore.py`, `link-mac.py`.

---

## 6. Domena — nierozstrzygnięte

`CNAME` mówi `ai.gzowo.fun`, ale **pod tym adresem stoi dziś inna strona** i decyzja,
czy Narew Labs ma ją przejąć, nie zapadła. Dopóki nie zapadnie, nie ma tu adresu
produkcyjnego. Repo GitHub też jeszcze nie istnieje.

Kiedy adres będzie znany, trzeba trzech rzeczy naraz: `CNAME` w repo, custom domain
w ustawieniach GitHub Pages, i wpis w Authorized domains w Firebase (§1). Brak
któregokolwiek = logowanie nie działa.

---

## 7. Model danych (Firestore)

```
users/{uid}                      profil: email, name, interests, onboarded,
                                 tier, baseTier, tierUntil, clientId,
                                 referredBy, referrals, createdAt
  ├─ conversations/{autoId}      title, model, messages[], createdAt, updatedAt
  ├─ usage/{autoId}              tokens, model, at        ← jeden dokument na odpowiedź
  └─ grants/{autoId}             tier, days, from, at     ← skrzynka, patrz niżej

referrals/{uid}                  referrer, referred, at   ← kluczowane poleconym
promoCodes/{code}                tier, active
```

**Dlaczego `usage` to osobne dokumenty, a nie licznik:** oba okna (5 godzin i tydzień)
są przesuwne, a licznika nie da się cofnąć.

**Dlaczego istnieje skrzynka `grants`:** za polecenie płaci się **polecającemu**, a jego
konta nie wolno ruszyć nikomu poza nim — taka jest cała reguła Firestore. Więc polecony
zostawia w podkolekcji `grants` jedną, wąsko zwalidowaną notkę (`tier: 'lin'`,
`days: 7`, `from` = jego własny uid, i nic więcej), a klient polecającego sam ją
odbiera i kasuje przy następnym wejściu. To jedyny wyjątek od „konto pisze tylko
właściciel", i istnieje wyłącznie dlatego, że nie ma tu serwera, który mógłby to zrobić.

**`referrals/{uid}` jest kluczowane poleconym**, więc jednego polecenia nie da się
zaliczyć dwa razy.

---

## 8. Czego tu nie ma i dlaczego

- **Płatności nie istnieją.** Checkout w `js/views/upgrade.js` jest jawną atrapą —
  celowo nie ma w nim ani jednego pola na kartę, bo realistycznie wyglądający
  formularz, który po cichu nic nie robi, byłby tu jedyną nieuczciwą rzeczą.
  Podsumowanie jest prawdziwe, przycisk jest prawdziwy, brak płatności jest nazwany.

- **Tiery są samo-przyznawalne i to jest decyzja, nie luka.** Reguły pozwalają
  właścicielowi konta ustawić sobie własny `tier`. Skoro nie ma płatności i nie ma
  serwera, który mógłby cokolwiek zweryfikować, udawanie kontroli byłoby teatrem.

- **Nie ma modelu wideo.** Ani wytrenowanego, ani trenowanego, ani zaplanowanego na
  termin. Video Studio pokazuje kształt, jaki miałoby narzędzie, i mówi to wprost —
  bez odliczania i bez listy oczekujących.

- **G-Images istnieje jako specyfikacja i pipeline treningowy, który nigdy nie
  poszedł.** Image Studio jest gotowe i wysyła prawdziwe zadania tym samym mostem
  co chat — kiedy Mac ogłosi, że ma ten model. Kiedy nie ogłasza, ekran mówi, że
  nie umie. Nie ma podstawionej generacji.

- **Liczenie tokenów jest przybliżone** — most streamuje tekst, nie liczby tokenów,
  więc `store.estimateTokens` dzieli znaki przez średni polski token. Wszędzie, gdzie
  to widać, jest podpisane jako szacunek.

- **Nie ma serwera i nie będzie.** Wszystko, czego zwykle pilnuje backend, pilnują
  tu reguły bezpieczeństwa albo nikt. Wersja „albo nikt" jest w tym pliku wypisana.
