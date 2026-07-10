# Runbook: postawienie sklepu B2B na Open Mercato w Dockerze (dla agenta AI)

> **Dla kogo:** Ten dokument jest instrukcją wykonawczą dla agenta AI (lub innego
> operatora), który ma od zera postawić środowisko Open Mercato **w całości w
> kontenerach Docker**, z **przykładowymi danymi**, a następnie **wpiąć własny
> template widoków w React** do aplikacji Next.js (albo podmienić wygląd).
>
> **Zasada nadrzędna:** wykonuj kroki po kolei. Nie modyfikuj plików `*.generated.ts`
> ani plików bezpośrednio w `apps/mercato/src/` **poza** `apps/mercato/src/modules/`.
> Nie uruchamiaj `yarn db:migrate` ręcznie na hoście — migracje odpala kontener.

---

## 0. Cel i efekt końcowy

Po wykonaniu tego runbooka:

- Cała platforma (aplikacja Next.js + PostgreSQL + Redis + Meilisearch) działa w Dockerze — **bez lokalnego Node/Yarn**.
- Baza jest zmigrowana i **zaseedowana danymi przykładowymi** (kanał sprzedaży, produkty z cenami, klienci B2B, przykładowe oferty/zamówienia).
- Panel administracyjny jest dostępny pod `http://localhost:3000/backend`.
- Portal klienta (B2B self-service) jest dostępny pod `http://localhost:3000/{orgSlug}/portal`.
- Własny template React jest wpięty jako moduł aplikacyjny w `apps/mercato/src/modules/<module>/frontend/`.

---

## 1. Wymagania

Na maszynie hosta wystarczy:

- **Docker** + **Docker Compose v2** (`docker compose ...`).
- **Git**.

**Nie jest potrzebny** lokalny Node.js ani Yarn — wszystko (instalacja zależności,
build pakietów, generowanie rejestru modułów, migracje, seed) dzieje się wewnątrz
kontenera `app` przy pierwszym starcie.

Zasoby: zalecane min. ~6–8 GB RAM dla Dockera (aplikacja startuje z
`NODE_OPTIONS=--max-old-space-size=3072`).

---

## 2. Pobranie kodu i gałąź

```bash
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato
git checkout develop   # lub gałąź wskazaną przez właściciela projektu
```

---

## 3. Konfiguracja środowiska (plik `.env` w katalogu głównym)

**Ważne:** dla ścieżki dockerowej `docker compose` czyta plik **`.env` w katalogu
głównym repo** (podstawianie zmiennych `${VAR:-default}` w plikach compose). To
**nie jest** to samo co `apps/mercato/.env`. Sam kontener `app` dostaje zmienne z
bloku `environment:` w pliku compose — większość ma sensowne domyślne wartości
wskazujące na hostnamey kontenerów (np. `DATABASE_URL` → `mercato-postgres-...`).

Utwórz plik `./.env` w katalogu głównym i nadpisz tylko to, co istotne:

```bash
cat > .env <<'EOF'
# --- Baza danych (używane też przez podstawianie w compose) ---
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=open-mercato

# --- Sekrety (ZMIEŃ na produkcji) ---
JWT_SECRET=change-me-dev-secret
TENANT_DATA_ENCRYPTION_FALLBACK_KEY=dev-tenant-encryption-fallback-key-32chars

# --- Konto administratora tworzone przy inicjalizacji ---
OM_INIT_SUPERADMIN_EMAIL=superadmin@acme.com
OM_INIT_SUPERADMIN_PASSWORD=password

# --- Publiczny URL ---
APP_URL=http://localhost:3000

# --- (opcjonalnie) AI Assistant ---
# OPENAI_API_KEY=sk-...
EOF
```

Uwagi:
- Jeśli nie ustawisz `OM_INIT_SUPERADMIN_EMAIL`, init użyje domyślnego
  `superadmin@acme.com`; domyślne hasło w compose to `password`. **Zapisz te dane** —
  będą potrzebne do logowania. Wyświetlą się też w logach kontenera.
- Szyfrowanie danych tenanta jest domyślnie **włączone** (`TENANT_DATA_ENCRYPTION=true`),
  dlatego ustaw silny `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` (min. 32 znaki).

---

## 4. Uruchomienie całości w Dockerze (z przykładami)

```bash
yarn docker:dev:up
# = docker compose -f docker-compose.fullapp.dev.yml up --build -d
```

> Jeśli host nie ma Yarna, uruchom bezpośrednio:
> `docker compose -f docker-compose.fullapp.dev.yml up --build -d`

Co się dzieje przy **pierwszym** starcie kontenera `app`
(`docker/scripts/dev-entrypoint.sh`):

1. `yarn install` — instalacja zależności w wolumenie kontenera.
2. `yarn build:packages` → `yarn generate` → `yarn build:packages` — build pakietów
   i wygenerowanie rejestru modułów (`apps/mercato/.mercato/generated/*`).
3. `yarn mercato init` (przez `docker/scripts/init-or-migrate.sh`) — **pełna
   inicjalizacja z przykładami**: migracje bazy, utworzenie tenanta + organizacji +
   ról + użytkowników, `seedDefaults` (waluty, jednostki, stawki VAT, metody
   płatności/wysyłki, statusy) oraz `seedExamples` (kanały sprzedaży, produkty z
   cenami, klienci B2B, przykładowe oferty i zamówienia).
   - Init odpala się **tylko raz** — pilnuje tego plik-marker w wolumenie
     `init_marker` (`/tmp/init-marker/.seeded`). Kolejne restarty robią już tylko
     migracje.
4. `yarn dev` — start serwera Next.js z hot-reloadem (źródło jest zamontowane
   jako wolumen `.:/app`).

Pierwszy build i init trwają kilka–kilkanaście minut. Obserwuj logi:

```bash
docker compose -f docker-compose.fullapp.dev.yml logs -f app
```

Poczekaj na komunikat o gotowości serwera Next.js oraz na wypisane dane logowania.

---

## 5. Weryfikacja

- Panel admina: otwórz `http://localhost:3000/backend`, zaloguj się jako
  `superadmin@acme.com` / `password` (lub wartości z Twojego `.env`).
- Portal klienta: `http://localhost:3000/{orgSlug}/portal` — `orgSlug` znajdziesz
  w panelu (moduł Directory/Organizations) lub w logach seedowania.
- Zamówienia/oferty B2B: w panelu, moduł **Sales** — powinny być widoczne
  przykładowe dokumenty na kanale `field-sales`.

Porty wystawione na host: `3000` (aplikacja), `4000` (splash dev), `8080`
(Keycloak – dev SSO). Postgres/Redis/Meilisearch **nie są** wystawione na host —
działają tylko wewnątrz sieci dockerowej.

---

## 6. Dane obecne po instalacji (baza dla sklepu B2B)

Tworzone **zawsze** (init + `seedDefaults`): tenant, organizacja, role + ACL,
użytkownicy (superadmin/admin/employee), waluty, jednostki miary i rodzaje cen,
stawki VAT (`vat-23` domyślna, `vat-0`), metody płatności i wysyłki, sekwencje
numeracji dokumentów, statusy dokumentów.

Tworzone **z przykładami** (`seedExamples`, obecne bo init idzie bez `--no-examples`):
kanały sprzedaży (`online`, `field-sales`), przykładowe produkty z cenami, przykładowi
klienci B2B (firmy + kontakty), przykładowe oferty i zamówienia.

> **Minimum do złożenia zamówienia B2B** (gdyby seedy przykładowe były wyłączone):
> tenant + organizacja → **kanał sprzedaży** (wymagany dla każdego dokumentu) →
> waluta → produkt z ceną → stawka VAT + metoda płatności + metoda wysyłki → klient.
> Przy instalacji z przykładami wszystko to już istnieje.

---

## 7. Codzienne komendy (praca w kontenerze)

Komendy wykonuje się **wewnątrz** kontenera `app` (skrypty `docker:*` robią to za Ciebie):

```bash
yarn docker:generate       # regeneracja rejestru modułów po zmianach w modułach
yarn docker:db:generate    # wygenerowanie migracji po zmianie encji
yarn docker:db:migrate     # zastosowanie migracji
yarn docker:typecheck      # typecheck w kontenerze
yarn docker:lint           # lint w kontenerze
yarn docker:test           # testy w kontenerze
yarn docker:mercato -- <cmd>   # dowolna komenda CLI mercato w kontenerze

docker compose -f docker-compose.fullapp.dev.yml logs -f app   # logi
yarn docker:dev:down       # zatrzymanie stacku
```

> **Reset od zera** (skasowanie danych i ponowny init z przykładami): zatrzymaj
> stack i usuń wolumeny (m.in. `mercato-postgres-data-*` oraz `mercato-init-marker-*`),
> po czym ponownie `yarn docker:dev:up`. Usunięcie marker-wolumenu wymusza pełny init.

---

## 8. Wpięcie własnego template'u React (widoki frontendu)

Open Mercato ma **jedno drzewo Next.js App Router** w `apps/mercato/src/app/`.
Moduły **nie** dostarczają własnych folderów `app/` — dostarczają foldery
`frontend/` i `backend/`, które generator mapuje na trasy (catch-all route
rozwiązuje je w runtime). Twoje widoki wpinasz więc jako **moduł aplikacyjny**.

### 8.1. Gdzie umieścić kod (reguła projektu)

Nie wolno dodawać kodu bezpośrednio w `apps/mercato/src/` **poza** podkatalogiem
`modules/`. Twój kod trafia do:

```
apps/mercato/src/modules/<twoj_modul>/
```

Wzoruj się 1:1 na istniejącym module referencyjnym `apps/mercato/src/modules/example/`
(zawiera `frontend/`, `backend/`, `api/`, `widgets/`, `index.ts` itd.).

### 8.2. Konwencja tras (folder → URL)

- `frontend/<ścieżka>/page.tsx` → `/<ścieżka>` (strona publiczna)
- `frontend/[orgSlug]/portal/<ścieżka>/page.tsx` → `/{orgSlug}/portal/<ścieżka>`
  (strona portalu klienta — właściwe miejsce na **sklep B2B self-service**)
- `api/<method>/<ścieżka>.ts` → `/api/<ścieżka>`
- Obok każdej `page.tsx` możesz dodać `page.meta.ts` (bramki auth, pozycja w nawigacji).

Przykład publicznej, nieautoryzowanej strony do podejrzenia:
`packages/core/src/modules/sales/frontend/quote/[token]/page.tsx`
(klient-side, używa `apiCallOrThrow` i prymitywów z `@open-mercato/ui/primitives/*`).

### 8.3. Strona portalu B2B (autoryzowana) — meta z bramką

```ts
// apps/mercato/src/modules/<twoj_modul>/frontend/[orgSlug]/portal/shop/page.meta.ts
import type { PageMetadata } from '@open-mercato/shared/modules/registry/types'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.shop.view'],
  nav: { label: 'Shop', labelKey: 'shop.nav.title', group: 'main', order: 10 },
}
```

- `requireCustomerAuth: true` → brak sesji klienta przekierowuje do
  `/{orgSlug}/portal/login`.
- `requireCustomerFeatures` → sprawdzenie uprawnień klienta (RBAC portalu). Grant
  nadaje się deklaratywnie w `setup.ts` przez `defaultCustomerRoleFeatures`.
- **Pominięcie `page.meta.ts` wyłącza bramkę** — dla stron chronionych meta jest obowiązkowe.

Sam komponent strony (`page.tsx`) to zwykły komponent React. Twoje widoki z
template'u przenosisz tutaj i podmieniasz warstwę danych na wywołania API Open
Mercato (`apiCall`/`apiCallOrThrow` z `@open-mercato/ui/backend/utils/apiCall` —
nie używaj surowego `fetch`). Prymitywy UI i shell portalu masz w
`@open-mercato/ui/portal/*` (np. `PortalLayoutShell`, `PortalPageHeader`, `PortalCard`).

### 8.4. Rejestracja i wykrycie modułu

1. Dodaj wpis w `apps/mercato/src/modules.ts` do `enabledModules` (analogicznie do
   istniejącego `example`), ze źródłem `@app`:

   ```ts
   { id: '<twoj_modul>', from: '@app' }
   ```
   `@app` = `apps/mercato/src/modules/`.

2. Zregeneruj rejestr i zrestartuj (w kontenerze):

   ```bash
   yarn docker:generate
   ```
   Generator zeskanuje moduł i zaktualizuje manifesty w
   `apps/mercato/.mercato/generated/` (`frontend-routes.generated.ts` itd.).
   Nie edytuj plików `*.generated.ts` ręcznie.

3. Odśwież przeglądarkę — nowa trasa jest aktywna (hot-reload obsługuje zmiany w
   komponentach; dodanie **nowych** stron/modułów wymaga `yarn docker:generate`).

### 8.5. Style i design system

- Tailwind **v4** (config CSS-first, bez `tailwind.config.*`). Wejście stylów:
  `apps/mercato/src/app/globals.css`. Pliki w `apps/mercato/src/**` są skanowane
  domyślnie, więc klasy Tailwind w Twoim module zadziałają bez dodatkowej konfiguracji.
- Prymitywy: `@open-mercato/ui/primitives/*` (Button, Input, Select, DataTable,
  Badge, Spinner, EmptyState…). Listy → `DataTable`, formularze → `CrudForm`.
- i18n: `useT()` po stronie klienta; nie hardkoduj tekstów użytkownika.

---

## 9. Podmiana wyglądu ("skórki")

Dwa wspierane sposoby — nie edytuj rdzenia:

### 9.1. Tokeny motywu (globalny re-skin)

Kolory/promienie/czcionki to zmienne CSS zdefiniowane w
`apps/mercato/src/app/globals.css` (bloki `@theme inline`, `:root`, `.dark`).
Zmiana wyglądu globalnie = nadpisanie tych zmiennych (np. `--primary`, `--accent`,
`--radius`, czcionki). Tryb ciemny jest sterowany klasą `.dark` (skrypt `om-theme`
w `apps/mercato/src/app/layout.tsx`, stan w `localStorage['om-theme']`).

### 9.2. Podmiana komponentów (bez dotykania core)

System **Component Replacement** pozwala podmienić lub owinąć konkretny komponent
UI bez edycji rdzenia. W swoim module deklarujesz `widgets/components.ts`
eksportujący `componentOverrides: ComponentOverride[]`. Tryby (kolejność preferencji):

- `wrapper` — owija oryginał, zachowuje propsy (preferowane, addytywne),
- `props` — transformuje propsy,
- `replace` — pełna podmiana (musi zachować zgodne propsy).

Cele to stabilne uchwyty (`page:*`, `section:*`, `data-table:*`, `crud-form:*`,
uchwyty portalu `page:portal:layout`, `section:portal:{header,footer,sidebar,user-menu}`).
Wzór do skopiowania: `apps/mercato/src/modules/example/widgets/components.ts`.
Po dodaniu override'ów uruchom `yarn docker:generate`.

---

## 10. Pułapki i ograniczenia (przeczytaj przed implementacją)

- **Storefront (SPEC-029) NIE jest jeszcze zaimplementowany** — nie ma modułu
  `ecommerce` ani `apps/storefront/`. Nie importuj z nich. Wspieranym miejscem na
  UI sklepu B2B jest **portal** (`frontend/[orgSlug]/portal/...`) w module `@app`.
- **Każdy dokument sprzedaży musi mieć kanał** (`SalesChannel`). Instalacja z
  przykładami tworzy `online` i `field-sales`; przy czystej instalacji utwórz kanał
  przed pierwszym zamówieniem.
- **Nie edytuj** plików `*.generated.ts` ani kodu bezpośrednio w `apps/mercato/src/`
  poza `modules/`.
- **Nie odpalaj** `yarn db:migrate` ręcznie na hoście — w Dockerze migracje wykonuje
  entrypoint kontenera; nowe migracje twórz przez `yarn docker:db:generate` i
  przeglądaj wygenerowany SQL + snapshot.
- Portal wymaga włączonego feature toggle `portal_enabled` dla organizacji oraz
  konwencji ścieżki z `[orgSlug]` jako pierwszym segmentem.

---

## 11. Definition of Done (checklista dla agenta)

- [ ] `yarn docker:dev:up` zakończone; kontener `app` działa (`logs` pokazują gotowy Next.js).
- [ ] `http://localhost:3000/backend` otwiera się i logowanie superadminem działa.
- [ ] W module Sales widoczne przykładowe dokumenty B2B (kanał `field-sales`).
- [ ] `http://localhost:3000/{orgSlug}/portal` otwiera portal klienta.
- [ ] Własny moduł istnieje w `apps/mercato/src/modules/<module>/`, jest w
      `enabledModules`, a `yarn docker:generate` przeszło bez błędów.
- [ ] Nowa trasa frontendu odpowiada pod oczekiwanym URL.
- [ ] Ewentualne podmiany wyglądu zrobione przez tokeny CSS lub `componentOverrides`,
      bez edycji rdzenia.

---

## Mapa kluczowych plików

| Zagadnienie | Ścieżka |
|---|---|
| Compose (pełna aplikacja, dev/hot-reload) | `docker-compose.fullapp.dev.yml` |
| Entrypoint dev kontenera | `docker/scripts/dev-entrypoint.sh` |
| Skrypt init/migrate (marker) | `docker/scripts/init-or-migrate.sh` |
| Skrypty `docker:*` | `package.json` (sekcja scripts) |
| Przykład env aplikacji | `apps/mercato/.env.example` |
| Root layout / theme init | `apps/mercato/src/app/layout.tsx` |
| Catch-all frontendu (routing + auth) | `apps/mercato/src/app/(frontend)/[...slug]/page.tsx` |
| Style / Tailwind v4 / tokeny | `apps/mercato/src/app/globals.css` |
| Rejestracja modułów | `apps/mercato/src/modules.ts` |
| Wzorcowy moduł aplikacyjny | `apps/mercato/src/modules/example/` |
| Przykład strony publicznej | `packages/core/src/modules/sales/frontend/quote/[token]/page.tsx` |
| Portal klienta (UI) | `packages/core/src/modules/portal/frontend/[orgSlug]/portal/*` |
| Prymitywy portalu | `packages/ui/src/portal/` |
| Wzór podmiany komponentów | `apps/mercato/src/modules/example/widgets/components.ts` |
