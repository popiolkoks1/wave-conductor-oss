# Manifest — pełna specyfikacja

Plik YAML. Ścieżki względne liczą się od katalogu manifestu; `~` działa.

## Pola główne

| pole | domyślnie | znaczenie |
|---|---|---|
| `name` | — (wymagane) | nazwa przebiegu (tytuł powiadomień i raportu) |
| `repo` | — (wymagane) | repo projektu; jego katalog MUSI stać na `mainBranch` — tam dyrygent przewija main `--ff-only` |
| `planDir` | — (wymagane) | katalog planu; `promptFile`, `context`, `mergePromptFile` liczą się od niego |
| `mainBranch` | `main` | gałąź, do której wpadają fale |
| `context` | `[]` | pliki planu, które czyta nadzorca i które każda sesja ma przeczytać na starcie (README, zasady wspólne) |
| `worktreeRoot` | `<repo>-conductor-wt` | gdzie powstają worktree torów i integracji. Ustaw w katalogu z CLAUDE.md/`.claude` projektu, żeby sesje dziedziczyły reguły |
| `stateDir` | `.conductor` | stan przebiegów: `<stateDir>/<runId>/` + `current.json` |
| `sessionCwd` | worktree | katalog startowy sesji (np. katalog z hookami projektu, jak `~/projects`); praca i tak idzie w worktree |
| `mergePort` | `basePort + 90` | port serwera dev sesji scalającej |
| `setup` | `[]` | polecenia w każdym nowym worktree (np. `cd frontend && pnpm install --frozen-lockfile`) |
| `basePort` | `4100` | tor N w fali dostaje port `basePort + N` na serwer dev |
| `maxParallel` | `4` | ile torów naraz |
| `maxFixAttempts` | `3` | ile razy sesja dostaje czerwone bramki do poprawy, zanim tor zostanie odłożony |
| `maxFollowUps` | `4` | ile razy nadzorca może odpowiedzieć sesji, która skończyła pytaniem tekstem |
| `maxTurns` | — | limit tur jednej sesji |
| `maxBudgetUsd` | — | limit kosztu jednej sesji (szacunek SDK) |
| `maxRunBudgetUsd` | — | limit kosztu całego przebiegu; po przekroczeniu nowe tory nie startują, przebieg kończy się raportem |
| `sessionTimeoutMin` | `240` | sesja dłuższa niż tyle minut zegara jest przerywana i wznawiana z podpowiedzią (zwykle wisi na serwerze dev na pierwszym planie) |
| `minFreeGb` | `10` | poniżej tylu GB nie powstaje nowy worktree — dyrygent czeka |
| `mainBusyWaitMin` | `120` | ile czekać na dysk / na katalog repo zajęty inną gałęzią lub zmianami, zanim przebieg się zatrzyma |
| `settingSources` | `[project, local]` | które ustawienia Claude Code ładują sesje (CLAUDE.md, hooki projektu) |
| `models` | domyślny | `track`, `supervisor`, `merge`, `judge`, `reviewer` (recenzent pokazu, domyślnie `judge`), `light` (szybki model do oceny „czy sesja skończyła”, domyślnie `supervisor`) — id modeli, np. `claude-opus-5-5` |
| `requires` | `[]` | narzędzia, które muszą być na PATH (`doctor` sprawdza przed startem), np. `[node, pnpm, make, cargo]` |
| `review` | — | niezależny recenzent i pokaz projektu — patrz niżej |
| `earlyPortOffset` | `50` | przesunięcie portów torów startujących wcześniej (`needs`): `basePort + offset + (nr fali % 4) × 10 + nr toru` |
| `notify` | `{macos: true, heartbeatHours: 6}` | patrz niżej |
| `policy` | patrz niżej | zakazy i push |
| `waves` | — (wymagane) | lista fal, wykonywanych po kolei |

## `notify`

| pole | znaczenie |
|---|---|
| `macos` | Centrum powiadomień macOS |
| `ntfy` | temat ntfy.sh — powiadomienie na telefon (aplikacja ntfy, subskrypcja tematu; temat traktuj jak hasło) |
| `command` | dowolne polecenie; dostaje `$CONDUCTOR_KIND` i `$CONDUCTOR_MESSAGE` (np. webhook Slacka przez curl) |
| `heartbeatHours` | znak życia, gdy tyle godzin nic nie przyszło; `0` = wyłączone |

Powiadomienia są rzadkie z założenia: **start**, **koniec każdej fali**, **koniec przebiegu** (gotowe albo zatrzymany),
**problem środowiska** (dysk, zajęty main, długie czekanie na reset limitu, padnięty proces), rzadki **znak życia**.
Każde trafia też do `<run>/notify.jsonl`, z którego czyta `conduct watch`.

## `policy`

| pole | domyślnie | znaczenie |
|---|---|---|
| `push` | `false` | `git push origin <main>` po każdej scalonej fali (nigdy `--force`) |
| `denyBash` | `[]` | dodatkowe wzorce regex zakazanych poleceń (np. `tools/publish`, `deploy`) |
| `writeRoots` | `[]` | katalogi, w których sesje mogą pisać poza swoim worktree (np. `~/.claude/projects` — pamięć) |
| `denyPaths` | `[]` | ścieżki względem worktree, do których nie wolno pisać (np. `math/`, `src/types/`) — twardo, hookiem |

## `review` — niezależny recenzent i pokaz

Pokaz robi DYRYGENT, nie sesja toru: stawia serwer w worktree, czeka na 200, odpala polecenie zrzutów, ubija serwer.
Recenzent dostaje tylko zrzuty i kryteria — nie czyta raportów ani samooceny torów.

| pole | znaczenie |
|---|---|
| `serve` | polecenie serwera w worktree, w tle; `{port}` podstawia dyrygent |
| `ready` | ścieżka sprawdzana, aż odpowie 200 (domyślnie `/`) |
| `showcase` | polecenie zrzutów; `{url}` i `{out}` podstawia dyrygent; PNG-i w `{out}` (stałe nazwy — strona „przed / po” paruje je po nazwie) |
| `instructions` | dodatkowy opis roli recenzenta i wymagań projektu; bez narzuconej branży ani estetyki |
| `criteria` | pliki kryteriów oceny (względem planDir albo absolutne), np. checklista dostępności i wymagania produktu |
| `judge` | sędzia wariantów ocenia po zrzutach, nie po samoocenie (domyślnie `true`) |
| `wave` | po scaleniu fali: pokaz + ocena 0–3★; `fix` = jedna runda poprawek sesji scalającej, cofana, jeśli psuje bramki (domyślnie `true`) |
| `port` | port serwera pokazu (domyślnie `mergePort + 5`) |

Wynik: `<run>/showcase/<fala>.html` (strona „przed / po” z oceną), gwiazdki w `REPORT.md` i w powiadomieniu po fali.
`REPORT.md` jest przepisywany na bieżąco (najwyżej co 15 s), z czasem każdego toru i fali.

## Fala

| pole | znaczenie |
|---|---|
| `id` | identyfikator (gałąź integracji: `integration/<id>`) |
| `tracks` | tory; wszystkie startują od `main` po poprzedniej fali |
| `gates` | bramki odpalane w każdym torze (dokładane do bramek toru) |
| `integrationGates` | bramki po scaleniu (domyślnie = `gates`) |
| `mergePromptFile` / `mergePrompt` | prompt scalania; bez niego dyrygent scala sam, a konflikty oddaje sesji |

## Tor

| pole | znaczenie |
|---|---|
| `id` | identyfikator, unikalny w całym manifeście |
| `promptFile` / `prompt` | zadanie sesji |
| `branch` | nazwa gałęzi (domyślnie `wave/<id>`); zajęta cudzą, nie scaloną pracą → dyrygent weźmie `<branch>-r2` |
| `base` | inna baza niż `main` |
| `required` | tor nie przeszedł → przebieg kończy się (zamiast iść dalej bez niego) |
| `variants` | `[{id, note}]` — każdy wariant w osobnym worktree; sędzia wybiera zwycięzcę; przegrane zostają na gałęziach `<branch>--<id>` |
| `judgeCriteria` | czym sędzia ma się kierować |
| `gates` | bramki tylko tego toru |
| `model` | inny model dla tego toru |
| `done` | tor zrobiony przed przebiegiem — gałąź (lokalna albo z origin) idzie prosto do scalania, bez sesji. Tak wznawia się plan w połowie |
| `dir` | nazwa katalogu worktree w `worktreeRoot` (gdy prompt planu podaje konkretny katalog) |
| `port` | port serwera dev (gdy prompt planu podaje konkretny port) |
| `denyPaths` | zamrożone ścieżki tylko dla tego toru, dokładane do `policy.denyPaths` (np. tory frontendu bez `math/`) |
| `needs` | tory z WCZEŚNIEJSZYCH fal, od których ten tor zależy. Gdy wszystkie są zielone (warianty — rozstrzygnięte), tor startuje od razu, jeszcze w trakcie poprzedniej fali, od gałęzi `prestart/<id>` = main + ich gałęzie. Jeśli któraś zależność ostatecznie nie wejdzie do main, tor jest odkładany (nie wniesie jej tylnymi drzwiami). Bez `needs` — czeka na koniec poprzedniej fali |

## Bramka

| pole | domyślnie | znaczenie |
|---|---|---|
| `name` | — | nazwa (w raporcie; ta sama nazwa = ta sama bramka przy pomiarze bazowym) |
| `run` | — | polecenie; zielona = kod 0 |
| `cwd` | `.` | katalog względem worktree |
| `runs` / `mustPass` | `1` / `runs` | tłumienie szumu: zielona, gdy `mustPass` z `runs` przebiegów przejdzie |
| `timeoutSec` | `1800` | limit czasu jednego przebiegu |
| `baseline` | `true` | tylko bramki fali/integracji: `false` = bramka sprawdza NOWĄ rzecz (cel), więc nie wolno jej mierzyć na main |

**Cel czy regresja?** Bramka toru = cel toru (np. „README istnieje”) — zawsze blokuje. Bramka fali/integracji = regresja
(np. „testy i check zielone”) — mierzona bazowo. Bramka fali, która sprawdza nową rzecz, dostaje `baseline: false`,
inaczej na main byłaby czerwona i przestałaby cokolwiek pilnować.

**Pomiar bazowy:** przed każdą falą dyrygent odpala jej bramki regresji na czystym `main`. Bramka czerwona już tam
nie blokuje torów w tej fali (tylko informacyjna, oznaczona w raporcie `◌`) — inaczej jeden stary błąd odłożyłby każdy tor.
Porównanie „nie gorzej niż baza” zapisz jako skrypt, który sam zwraca 0/1.

## Rozszerzenia: onboarding i kontrola wyników

- `conduct init <manifest> --repo <repo>` tworzy plan bez nadpisywania istniejącego pliku.
- `conduct plan <manifest>` pokazuje fale, zależności, bramki, budżety i gałąź wyniku bez uruchamiania modeli.
- `policy.outputBranch`: wynik na osobnej gałęzi i w worktree `_result`; źródłowy main pozostaje bez zmian. Brak pola zachowuje dotychczasowe zachowanie. Osobny plan powinien mieć własne outputBranch i worktreeRoot.
- `policy.protectedPaths`: lista pathspeców Git, których zmiana w commitach blokuje integrację. Nadaje się do wcześniej zapisanych testów akceptacyjnych.
- `gate.failuresFile`: świeży plik JSON z tablicą identyfikatorów nieudanych testów, względem cwd bramki. Nowe porażki względem pomiaru bazowego blokują. Brak lub zły format raportu również blokuje. Polecenie musi zwrócić kod niezerowy przy porażkach i zapisać `[]` przy sukcesie.

Przykłady i ograniczenia: [English quickstart](QUICKSTART.md).
