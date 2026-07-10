# Podmiana frontendu i CSS w Open Mercato

Ten dokument opisuje, jak w monorepo Open Mercato zmienić **wygląd (CSS / branding)** oraz **komponenty i strony frontendu**, bez forkowania kodu pakietów `@open-mercato/*`.

W skrócie są dwie niezależne warstwy:

| Chcę zmienić… | Warstwa | Gdzie |
|---|---|---|
| Kolory, logo, typografię, dark mode | **CSS / tokeny** | `apps/mercato/src/app/globals.css` |
| Pojedynczy komponent (tabela, formularz, sekcja) | **UMES – nadpisania komponentów** | `src/modules/<moduł>/widgets/components.ts` |
| Całą stronę / trasę | **Nadpisania na poziomie modułu** | `entry.overrides` |
| Zupełnie nowy ekran / portal | **Własny moduł** | `src/modules/<moduł>/backend/**` |

---

## 1. Podmiana CSS / wyglądu (theming)

Design system to **Tailwind CSS v4 w trybie „CSS-first"** — **nie ma pliku `tailwind.config.js`**. Cała konfiguracja i wszystkie kolory to **zmienne CSS (design tokens)** w jednym pliku:

```
apps/mercato/src/app/globals.css
```

importowanym raz w `apps/mercato/src/app/layout.tsx`.

### Struktura pliku

| Sekcja | Linie (orient.) | Co robi |
|---|---|---|
| `@theme inline { … }` | ~41–172 | Mostek: mapuje zmienne na klasy Tailwind (`--color-primary: var(--primary)` → działa `bg-primary`) |
| `:root { … }` | ~174–292 | Wartości tokenów dla **trybu jasnego** |
| `.dark { … }` | ~302–411 | Te same tokeny dla **trybu ciemnego** |

Kolory zapisane są w modelu **OKLCH**.

### Jak przemalować aplikację

Zmieniasz **wartości zmiennych** w `:root` (i odpowiadające w `.dark`). Ponieważ każda klasa Tailwinda odwołuje się do zmiennej, zmiana jednej wartości przeskórowuje całą aplikację:

```css
/* apps/mercato/src/app/globals.css */

:root {
  /* Kolor główny — zmienia wszystkie bg-primary / text-primary / border-primary */
  --primary: oklch(0.55 0.18 265);
  --primary-foreground: oklch(0.98 0 0);

  /* Powierzchnie */
  --background: oklch(1 0 0);
  --card: oklch(1 0 0);

  /* Tokeny statusów (błąd/sukces/ostrzeżenie/info) */
  --status-success-bg: oklch(0.95 0.05 150);
  --status-success-text: oklch(0.45 0.12 150);
}

.dark {
  --primary: oklch(0.65 0.18 265);
  --primary-foreground: oklch(0.15 0 0);
  --background: oklch(0.16 0 0);
  --card: oklch(0.20 0 0);
  /* ... odpowiedniki dla trybu ciemnego ... */
}
```

Najczęściej edytowane grupy tokenów:

- **Marka / akcje** — `--primary`, `--secondary`, `--accent`, `--ring`
- **Powierzchnie** — `--background`, `--card`, `--popover`, `--muted`
- **Statusy** — `--status-{error|success|warning|info|neutral}-{bg|text|border|icon}`
- **Obramowania i pola** — `--border`, `--input`
- **Wykresy** — `--chart-1..5` oraz nazwane (`--chart-blue`, `--chart-emerald`, …)

### Logo i nazwa produktu

Nazwa produktu w panelu backoffice ustawiana jest w layoutcie backendu
(`apps/mercato/src/app/(backend)/backend/layout.tsx`, prop `productName`).
Logo podmienia się przez zasoby w `apps/mercato/public/` oraz komponenty shella.

### Dark mode

Tryb ciemny jest **klasowy** (`.dark` na `<html>`), nie media-query. Steruje nim
`packages/ui/src/theme/ThemeProvider.tsx` (zapis wyboru w `localStorage` pod kluczem `om-theme`),
a skrypt anti‑FOUC w `layout.tsx` ustawia klasę jeszcze przed hydracją.

### ⚠️ Zasady projektu (obowiązkowe)

Z reguł design systemu (`.ai/ds-rules.md`, `AGENTS.md`):

- **Nie hardkoduj kolorów Tailwinda statusów** (`text-red-500`, `bg-green-*`, `text-amber-*`) — używaj tokenów `{property}-status-{status}-{role}`.
- **Nie używaj wartości arbitralnych** (`text-[13px]`, `p-[13px]`, `rounded-[24px]`, `z-[9999]`) — trzymaj się skali DS.
- **Nie dodawaj `dark:` na tokenach semantycznych/statusowych** — one same się przełączają, bo mają wartości w `.dark`.
- **Nie hardkoduj hex/rgb w `className`** — zawsze nazwa tokenu.
- Obramowania: `border-border` / `border-input`, nie `border-gray-300`.

---

## 2. Podmiana pojedynczego komponentu (UMES – `widgets/components.ts`)

UMES (Universal Module Extension System) pozwala **podmienić, opakować lub zmodyfikować** dowolny „zarejestrowany" komponent frontendu **z poziomu modułu**, bez dotykania kodu źródłowego pakietu, w którym ten komponent żyje.

Moduł eksportuje tablicę `componentOverrides` z pliku:

```
src/modules/<moduł>/widgets/components.ts
```

### Trzy tryby nadpisania

| Tryb | Kształt | Kiedy |
|---|---|---|
| `replacement` | pełny komponent + `propsSchema` (Zod) | wymieniasz komponent w całości |
| `wrapper` | `(Original) => Component` | opakowujesz/dekorujesz istniejący |
| `propsTransform` | `(props) => props` | modyfikujesz propsy przed renderem |

Każde nadpisanie ma:
- `target.componentId` — **handle** (identyfikator miejsca do podmiany),
- `priority` — liczba (niższa = wcześniej w łańcuchu),
- opcjonalnie `features?: string[]` — bramkowanie RBAC (wildcard-aware).

### Handle (co można podmienić)

Budowniki handli z `@open-mercato/shared/modules/widgets/component-registry`:

```ts
ComponentReplacementHandles.page(path)              // `page:${path}`         — cała strona backendu
ComponentReplacementHandles.dataTable(tableId)      // `data-table:${tableId}`— tabela DataTable
ComponentReplacementHandles.crudForm(entityId)      // `crud-form:${entityId}`— formularz CrudForm
ComponentReplacementHandles.section(scope, id)      // `section:${scope}.${id}`— sekcja detalu
```

### Przykład A — `wrapper` (dekoracja istniejącej sekcji)

Realny przykład z repo (`apps/mercato/src/modules/example/widgets/components.ts`):

```ts
import * as React from 'react'
import type { ComponentOverride } from '@open-mercato/shared/modules/widgets/component-registry'
import { ComponentReplacementHandles } from '@open-mercato/shared/modules/widgets/component-registry'

export const componentOverrides: ComponentOverride[] = [
  {
    target: { componentId: ComponentReplacementHandles.section('ui.detail', 'NotesSection') },
    priority: 50,
    metadata: { module: 'example' },
    wrapper: (Original) => {
      const Wrapped = (props: unknown) =>
        React.createElement(
          'div',
          { className: 'rounded-md border border-dotted border-border/70 p-2' },
          React.createElement(Original, props as object),
        )
      Wrapped.displayName = 'ExampleNotesSectionWrapper'
      return Wrapped
    },
  },
]

export default componentOverrides
```

### Przykład B — `replacement` (pełna podmiana z walidacją propsów)

```ts
import { z } from 'zod'
import type { ComponentOverride } from '@open-mercato/shared/modules/widgets/component-registry'
import { ComponentReplacementHandles } from '@open-mercato/shared/modules/widgets/component-registry'
import MyCustomOrdersTable from './MyCustomOrdersTable'

const propsSchema = z.object({
  // opisz propsy, które przyjmuje oryginalny komponent
}).passthrough()

export const componentOverrides: ComponentOverride[] = [
  {
    target: { componentId: ComponentReplacementHandles.dataTable('orders') },
    priority: 50,
    metadata: { module: 'my_module' },
    replacement: MyCustomOrdersTable,
    propsSchema,
  },
]

export default componentOverrides
```

### Jak to jest podłączane

1. `yarn generate` skanuje każdy `widgets/components.ts` i generuje
   `apps/mercato/.mercato/generated/component-overrides.generated.ts`.
2. `apps/mercato/src/components/ComponentOverridesBootstrap.tsx` ładuje te wpisy do
   `ComponentOverrideProvider` (montowany w `AppProviders.tsx`).
3. W runtime host renderuje przez hook
   `useRegisteredComponent(handle, Fallback)` (klient) lub
   `resolveRegisteredComponent(handle, Fallback)` (SSR), który stosuje kolejno
   `replacement → wrapper → propsTransform` wg `priority`. Błąd nadpisania łapie
   `ReplacementErrorBoundary` i wraca do oryginału.

> **Rekomendacja:** najpierw próbuj `wrapper` / `propsTransform` (zmiany addytywne),
> a `replacement` dopiero gdy naprawdę wymieniasz komponent w całości. Handle trzymaj stabilne.

---

## 3. Podmiana całej strony / trasy (`entry.overrides`)

Gdy chcesz podmienić lub **wyłączyć całą stronę** (albo trasę API) istniejącego modułu,
użyj nadpisań na poziomie modułu (`@open-mercato/shared/modules/overrides`) — bez patchowania
źródeł upstreamu.

- Klucze tras stron: `'/backend/ścieżka'` lub `'/frontend/ścieżka'`.
- `null` = wyłącz trasę, `{ handler }` = podmień na własny komponent/handler.
- Dyspozytor powinien uruchamiać się z `bootstrap.ts` **przed** pierwszym załadowaniem rejestrów.

Szczegóły i pełna lista domen (API, subskrybenci, ACL, DI, widżety, powiadomienia…):
`packages/shared/AGENTS.md` → sekcja *Module-Level Overrides* oraz spec
`.ai/specs/implemented/2026-05-04-modules-ts-unified-overrides.md`.

---

## 4. Zupełnie nowy frontend / ekran (własny moduł)

Najcięższa, ale najbardziej elastyczna ścieżka — dodajesz **własny moduł**:

```
apps/mercato/src/modules/<moduł>/
  backend/<ścieżka>/page.tsx      # strona panelu
  backend/<ścieżka>/page.meta.ts  # metadane + guardy (requireAuth/requireFeatures)
  frontend/.../portal/...         # strony portalu klienta (opcjonalnie)
```

Po dodaniu plików uruchom `yarn generate` — CLI auto-wykryje trasy i wpisze je do
`apps/mercato/.mercato/generated/*.generated.ts`. Trasy renderują catch-all:
`app/(backend)/backend/[...slug]/page.tsx` (panel) oraz
`app/(frontend)/[...slug]/page.tsx` (strona publiczna + portal klienta).

Dla nowego frontu klienta użyj systemu portalu (`PortalShell`, hooki portalu,
`page.meta.ts` z `requireCustomerFeatures`) — patrz `packages/ui/AGENTS.md` → *Portal Extension*.

> Zasada projektu: **nie dodawaj kodu bezpośrednio w `apps/mercato/src/`** poza wygenerowanymi
> rejestrami `*.generated.ts`. Moduły użytkownika trafiają do `apps/mercato/src/modules/<moduł>/`.

---

## Którą warstwę wybrać?

```
Zmiana koloru / logo / czcionki      → 1. Tokeny CSS (globals.css)
Inny wygląd jednej tabeli/formularza → 2. UMES wrapper / propsTransform
Wymiana konkretnej tabeli/sekcji     → 2. UMES replacement
Inna zawartość istniejącej strony    → 3. entry.overrides (page route)
Zupełnie nowy ekran / portal         → 4. Własny moduł + yarn generate
```

## Kluczowe pliki i dokumentacja

| Zagadnienie | Ścieżka |
|---|---|
| Wszystkie tokeny CSS (`:root` / `.dark` / `@theme`) | `apps/mercato/src/app/globals.css` |
| Import CSS + skrypt dark mode | `apps/mercato/src/app/layout.tsx` |
| Provider motywu | `packages/ui/src/theme/ThemeProvider.tsx` |
| Rejestr nadpisań + handle | `packages/shared/src/modules/widgets/component-registry.ts` |
| Hook resolvujący (klient) | `packages/ui/src/backend/injection/useRegisteredComponent.tsx` |
| Provider nadpisań | `packages/ui/src/backend/injection/ComponentOverrideProvider.tsx` |
| Generator nadpisań | `packages/cli/src/lib/generators/extensions/component-overrides.ts` |
| Przykład nadpisania | `apps/mercato/src/modules/example/widgets/components.ts` |
| Nadpisania tras/stron | `packages/shared/src/modules/overrides.ts` |
| Reguły design systemu (kolory/tokeny) | `.ai/ds-rules.md`, `.ai/ui-components.md` |
| Component Replacement (opis) | `packages/core/AGENTS.md`, `packages/ui/AGENTS.md` |

> Po zmianach w plikach modułów pamiętaj o `yarn generate`, a przy podmianie tokenów
> zweryfikuj build (`yarn build:app`) i oba motywy (jasny/ciemny).
