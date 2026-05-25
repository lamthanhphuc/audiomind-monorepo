# FE-Audiomind `src` layout

```
src/
  app/              Main production flow (App.tsx, tests)
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
  styles/           Global CSS (production flow + shared tokens)
  types/            Shared TypeScript types
  utils/            Pure helpers (transcript, highlight)
  main.tsx          Entry point
```
