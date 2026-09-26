# Frontend — Swaraj AI UI

Two UIs, one backend API:

| UI | Source | Deploy free |
|---|---|---|
| Vanilla static (real workbench) | `../public/` (`index.html`, `workbench.html`, `config.js`) | Vercel static, Root = `public` |
| Next.js stub | `frontend/app/` | Vercel, Root = `frontend` |

## Vanilla (recommended — full workbench)

No build. `public/config.js` rewrites every `/api/*`, `/artifact/*`, `/uploads/*`, `/download/*` fetch + download/image link to the backend. Empty backend = same origin (monolith keeps working).

**Local split test:**

```powershell
# terminal 1 — backend API only:
$env:PORT=8000; $env:SERVE_STATIC="0"; node src/server.js
# terminal 2 — frontend static:
npx serve -l 3000 public
# open http://127.0.0.1:3000/workbench.html?backend=http://127.0.0.1:8000
```

**Vercel (free):** Import repo → Root Directory = `public` → no Build Command → Output = `.` (`public/vercel.json` already sets this). Then point it at the API by adding before `config.js` in a copy, or just open `https://YOUR-FRONTEND.vercel.app/workbench.html?backend=https://YOUR-BACKEND.onrender.com` once (remembered in localStorage).

**Docker:** `docker build -f frontend/Dockerfile -t swaraj-frontend .`

## Next.js (`frontend/`)

```powershell
cd frontend
npm install
$env:NEXT_PUBLIC_BACKEND_URL="http://127.0.0.1:8000"
npm run dev   # http://localhost:3000
```

## Backend

See `../backend/README.md`. Monolith still works: `npm start` → `http://127.0.0.1:8080`.
