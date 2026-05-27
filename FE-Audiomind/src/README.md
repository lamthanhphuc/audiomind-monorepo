# FE-Audiomind `src` layout

```
src/
  app/              Main flow — dashboard shell + API/realtime (App.tsx)
  assets/           Static assets
  components/
    analysis/       Gemini analysis panel (upload + realtime)
    dashboard/      Legacy dashboard shell widgets
    features/       Dashboard feature pages (analysis, mindmap, upload)
    realtime/       Live recording UI (recorder, meeting view, keywords)
    transcript/     Transcript display + IT highlighting
    ui/             Shared UI states (empty, loading, error)
  constants/        App constants (IT terms dictionary)
  hooks/            React hooks (realtime WS, audio recorder)
  services/         API, auth, config
  styles/
    tokens.css      Design tokens (colors, spacing, typography)
    base.css        Global reset & page background
    app.css         Shared utilities (status badges, realtime)
    dashboard.css   Figma dashboard shell (sidebar, upload, analysis)
  types/            Shared TypeScript types
  utils/            Pure helpers (transcript, highlight)
  main.tsx          Entry point
```

## Design

- Font: **Plus Jakarta Sans** (loaded in `index.html`)
- Theme: indigo/violet accent on light gradient background
- Components use CSS variables from `styles/tokens.css`
