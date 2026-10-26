---
name: wave-conductor
description: Uruchamia autonomicznego dyrygenta fal (wave-conductor) na planie z falami/torami i pilnuje go do końca z rzadkimi powiadomieniami. Użyj, gdy właściciel mówi „masz plan, uruchom bota / dyrygenta / wave-conductor”, „puść fale automatycznie”, „odpal plan i daj znać, jak skończy”, albo pyta o stan trwającego przebiegu.
---

# Dyrygent fal — uruchomienie i pilnowanie

Dyrygent: `<wave-conductor-checkout>` (polecenie `<wave-conductor-checkout>/bin/conduct`).
Pełny opis manifestu: `<wave-conductor-checkout>/docs/MANIFEST.md` — przeczytaj go, zanim napiszesz manifest.

**Zasada nadrzędna: właściciel po napisaniu planu nie podejmuje ŻADNYCH decyzji aż do końca wszystkich fal.**
Nie zadawaj mu pytań w trakcie. Niejasności w planie rozstrzygasz sam (odwracalnie) i zapisujesz w komentarzu manifestu.
Jedyny wyjątek: `doctor` zgłasza ✗, którego nie da się naprawić bez niego (np. brak klucza w ssh-agencie) — wtedy mówisz krótko, co zrobić, i kończysz.

## 1. Manifest z planu

1. Znajdź katalog planu (z wiadomości; zwykle zawiera `README.md`, zasady wspólne, pliki fal `F1-*.md`, prompt scalania `M-*.md`).
2. Przeczytaj README planu, zasady wspólne i KAŻDY plik fali. Wyciągnij: repo projektu, gałąź główną, kolejność fal,
   tory w fali (co idzie równolegle), nazwy gałęzi, jeśli plan je podaje, prompt scalania, bramki (polecenia testów z planu
   i z `package.json` repo — sprawdź, że istnieją), punkty STOP-KONCEPT / A/B.
3. Jeśli jeden plik opisuje kilka torów, dawaj torom `prompt:` z „wykonaj WYŁĄCZNIE sekcję X z pliku Y”, a nie ten sam `promptFile`.
4. A/B z planu, który ma zbudować oba warianty → `variants:` + `judgeCriteria:`. A/B „pokaż właścicielowi i poczekaj” → zwykły tor; nadzorca zdecyduje przez AskUserQuestion.
5. Tory, bez których dalsze fale nie mają sensu → `required: true`.
6. **Cel czy regresja:** sprawdzenie, że tor zrobił swoją NOWĄ rzecz → bramka TORU (`tracks[].gates`); testy/check/verify pilnujące,
   że nic się nie zepsuło → bramki FALI. Bramka fali sprawdzająca nową rzecz → `baseline: false` (inaczej będzie tylko informacyjna).
7. Bramki porównujące z bazą (np. testy wizualne vs F0) opakuj w skrypt zwracający 0/1 i dodaj `runs: 3, mustPass: 2`, jeśli są zaszumione.
8. `worktreeRoot` ustaw wewnątrz katalogu, który dostarcza CLAUDE.md i `.claude` projektu (np. `~/projects/.conductor-wt`), żeby sesje dziedziczyły reguły projektu. `basePort` poza portami, na których właściciel trzyma własne serwery.
9. Zapisz jako `<katalog planu>/conductor.yaml` i uruchom `conduct check <manifest>`; poprawiaj, aż przejdzie.

## 2. Start

```bash
<wave-conductor-checkout>/bin/conduct doctor <manifest>     # wszystko ✓ albo !, żadnego ✗
<wave-conductor-checkout>/bin/conduct start  <manifest>     # zwraca JSON: runId, notifyFile, reportFile
```

`start` odpala demona odłączonego od tej sesji — przebieg trwa dalej, nawet gdy okno się zamknie; po awarii procesu wznawia się sam.
Powiedz właścicielowi jednym–dwoma zdaniami: że wystartowało, ile fal/torów, i że dostanie powiadomienie po każdej fali i na końcu.

## 3. Pilnowanie i powiadomienia

Uzbrój **Monitor** (timeout 1 800 000 ms) na:

```bash
<wave-conductor-checkout>/bin/conduct watch <manifest> --from <N>
```

Pierwszy raz `N` = liczba linii w `notifyFile` (zwykle 1 — linia „start”, już widziana). Każde zdarzenie to jedna linia `rodzaj|N|treść` — zapamiętaj ostatnie `N`.

- `wave|N|…`, `problem|N|…`, `heartbeat|N|…` → **PushNotification** z treścią (jedna linia, < 200 znaków). Nic więcej nie rób.
- `done|N|…` albo `stopped|N|…` → przeczytaj `reportFile` (i `DECYZJE.md` obok), wyślij PushNotification z wynikiem, a w odpowiedzi daj właścicielowi krótkie podsumowanie:
  co weszło, co odłożone i dlaczego, bramki czerwone już na main, liczba decyzji nadzorcy, koszt, ścieżka do raportu. Koniec.
- Monitor wygasł bez `done/stopped` → uzbrój go ponownie z ostatnim `--from N`. Nie wysyłaj wtedy powiadomienia.

Sam dyrygent wysyła też powiadomienia macOS (i ntfy, jeśli jest w manifeście), więc właściciel dostanie je nawet, gdy ta sesja się zamknie.

## Pytania o stan w trakcie

`conduct status <manifest>` — raport na bieżąco + czy demon żyje. Zatrzymanie (tylko na wyraźne polecenie): `conduct stop <manifest>`;
wznowienie: `conduct start <manifest> --resume-last`.
