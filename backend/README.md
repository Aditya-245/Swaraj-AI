# Backend — Swaraj AI API

API-only server. Same code as the monolith (`../src/server.js`), run with split-mode env.

## Run locally (API only)

```powershell
$env:PORT=8000; $env:HOST="127.0.0.1"; $env:SERVE_STATIC="0"; node ../src/server.js
# health:
curl http://127.0.0.1:8000/api/health
# static is off:
curl http://127.0.0.1:8000/   # -> {"ok":false,"error":"static disabled (backend-only)..."}
```

Or from repo root: `npm run start:backend`.

## Deploy (Render free)

1. Push repo to GitHub.
2. Render → New → Web Service → select repo. Leave **Root Directory empty** (repo root).
3. Build: `npm install` · Start: `node src/server.js`
4. Env: `HOST=0.0.0.0` · `SERVE_STATIC=0` · `FRONTEND_URL=https://YOUR-FRONTEND.vercel.app` · `NODE_ENV=production`
5. Open `https://YOUR-BACKEND.onrender.com/api/health` → `{"ok":true,...,"static":false}`

## Notes

- Single source of truth: `../src/` — no code duplication. This folder holds deploy config only.
- CORS is enforced in `src/server.js` via `FRONTEND_URL`. Empty = allow `*` (local dev only).
- No disk on free tiers: `data/`, `out/`, `uploads/` are ephemeral. Auth needs external Postgres (`DATABASE_URL`); without it auth returns 503 and everything else still works offline.
- Ollama/Qdrant (`127.0.0.1:11434`) don't exist on Render — replies fall back to built-in template, still private.
