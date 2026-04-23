# Cricket Score (Node + Express + Socket.IO)

A simple live cricket scoreboard:
- **Client view**: public, read-only live score + match history
- **Admin view**: protected (HTTP Basic Auth) for updating score and recording matches
- **Storage**: SQLite file by default (stores on the server). Optional MongoDB.

## Run locally

```bash
npm install
npm start
```

Server starts on `http://localhost:3131` by default.

## Pages

- Client (public): `GET /client`
- Admin (Basic Auth): `GET /admin`

`/` redirects to `/client`.

## Admin login (Basic Auth)

Admin routes require HTTP Basic Auth.

Defaults:
- Username: `air19818`
- Password: `air19818`

You can override via environment variables:

- `ADMIN_USER`
- `ADMIN_PASS`

Example (Linux/macOS):

```bash
ADMIN_USER=air19818 ADMIN_PASS=air19818 npm start
```

## Database / Persistence

### Option A (recommended for “store on the server”): SQLite

SQLite writes to a local file on the server (for example on a VPS). This requires that your hosting has a **persistent filesystem**.

To force SQLite:
- Set `DB_KIND=sqlite`
- Ensure `MONGODB_URI` is not set

Example:

```bash
DB_KIND=sqlite npm start
```

The project uses the SQLite file in this folder (see `data.sqlite`).

### Option B: MongoDB (optional)

If you set `MONGODB_URI`, the server will try MongoDB first.

- `MONGODB_URI=mongodb+srv://...` (or `mongodb://...`)

Notes:
- In production, if MongoDB is unreachable (wrong URI, IP allowlist, DNS/network issues), match recording/history will fail.
- The app is designed to prefer MongoDB when available, but can fall back to SQLite if MongoDB init/operations fail (unless you force Mongo only).

To force Mongo only (no fallback):

```bash
DB_KIND=mongo MONGODB_URI='...' npm start
```

## Production notes

- If you host on a VPS/dedicated server with persistent disk: SQLite is usually fine.
- If you host on platforms with **ephemeral filesystems** (some container/serverless deployments): SQLite data may be lost on redeploy/restart. In that case you need either:
  - a persistent disk add-on/volume, or
  - an external database (MongoDB, Postgres, etc.).

## API (quick reference)

Public:
- `GET /api/matches` — list match history

Admin (Basic Auth required):
- `PUT /api/teams` — set team names
- `POST /api/matches` — record a match
- `DELETE /api/matches` — clear match history
- `GET /api/admin/socket-token` — issue an admin socket token for Socket.IO

## Real-time events (Socket.IO)

All clients receive live updates.

Admin-only socket events (require admin socket token):
- `updateMatch`
- `updateScore`
- `recordMatch` (ACK-based; more reliable behind some production proxies)
