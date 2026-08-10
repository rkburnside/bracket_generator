# Deploying to Railway

The app is a single Node process with a SQLite database on disk. That means two
things matter on Railway: it needs a **volume** (otherwise the database is wiped
on every deploy) and it must stay at **one replica** (SQLite has a single
writer). Both are already set in `railway.json`.

## Deploy from the dashboard

1. **Push the branch to GitHub** (already done for `claude/intelligent-feynman-wroi5o`).

2. **Create the project.** Go to [railway.com/new](https://railway.com/new) →
   **Deploy from GitHub repo** → pick `rkburnside/bracket_generator`. Authorise
   the Railway GitHub app for the repo if prompted.

3. **Pick the branch.** Service → **Settings → Source → Branch**. Choose the
   branch you want deployed (`main` once this is merged, or the feature branch to
   try it now). Railway auto-deploys every push to that branch.

4. **Add the volume.** This is the step that makes tournaments persistent.
   Service → **Data** (or right-click the service canvas → **Attach Volume**) →
   mount path **`/data`** → Add. Railway sets `RAILWAY_VOLUME_MOUNT_PATH=/data`,
   and the app puts `brackets.db` there automatically — no `DB_PATH` needed.

   > Attach the volume *before* people start using the app. Adding one later
   > gives you an empty database, because the old file was on ephemeral disk.

5. **Generate a domain.** Service → **Settings → Networking → Public Networking**
   → **Generate Domain**. Leave the port blank; Railway injects `PORT` and the
   app listens on it.

6. **Redeploy once after generating the domain.** `RAILWAY_PUBLIC_DOMAIN` is what
   the QR codes are built from, and it only lands in the environment on the next
   deploy. Deployments → **⋯ → Redeploy**.

7. **Check it.** Open `https://<your-domain>/healthz` — you should get
   `{"ok":true,"db":"/data/brackets.db"}`. If `db` is anything other than a path
   under your mount point, the volume is not attached.

That is the whole deploy. Create a game, and the lobby QR code will point at your
public Railway URL.

## Deploy from the CLI instead

```bash
npm i -g @railway/cli
railway login
railway init                 # creates the project
railway up                   # builds and deploys the current directory
railway volume add --mount-path /data
railway domain               # generates a public domain
railway up                   # redeploy so RAILWAY_PUBLIC_DOMAIN is picked up
railway open
```

## Environment variables

Nothing is required. These are the ones worth knowing about:

| Variable | Set it when | Value |
| --- | --- | --- |
| `PUBLIC_URL` | You put a **custom domain** on the service | `https://brackets.example.com` — no trailing slash |
| `DB_PATH` | You mounted the volume somewhere other than the default | `/mnt/whatever/brackets.db` |
| `PORT` | Never — Railway injects it | — |
| `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_VOLUME_MOUNT_PATH` | Never — Railway injects them | — |

`PUBLIC_URL` overrides everything else. If a QR code ever comes out pointing at
`localhost` or the wrong host, set `PUBLIC_URL` explicitly and redeploy.

Set variables under Service → **Variables**, or:

```bash
railway variables --set "PUBLIC_URL=https://brackets.example.com"
```

## Custom domain

Service → **Settings → Networking → Custom Domain** → enter the hostname, then
add the `CNAME` record Railway shows you at your DNS provider. Once it resolves,
set `PUBLIC_URL` to the same hostname and redeploy so the QR codes follow.

## What `railway.json` already handles

| Setting | Why |
| --- | --- |
| `buildCommand: npm ci --omit=dev` | Reproducible install from the lockfile |
| `startCommand: npm start` | Runs `node src/server.js` |
| `healthcheckPath: /healthz` | A deploy is only promoted once the database opens cleanly |
| `restartPolicyType: ON_FAILURE` | Restarts a crashed process, up to 5 times |
| `numReplicas: 1` | **Do not raise this.** Two replicas means two containers, and a Railway volume can only attach to one of them |

## Backups

The database is one file. To pull a copy down:

```bash
railway ssh "cat /data/brackets.db" > brackets-backup.db
```

Do it while no game is being scored — SQLite is in WAL mode, so a copy taken
mid-write may be missing the newest results. Railway can also snapshot the volume
from the Data tab.

## Troubleshooting

**The QR code points at the wrong host.** `PUBLIC_URL` wins over everything —
set it to your real URL and redeploy.

**Tournaments vanish after a deploy.** The volume is missing or mounted
somewhere the app is not writing. Check `/healthz`: the `db` path must be inside
your mount point.

**Health check fails on first deploy.** Usually the volume mount path and
`DB_PATH` disagree. Clear `DB_PATH` and let the app derive it from
`RAILWAY_VOLUME_MOUNT_PATH`.

**Build fails compiling `better-sqlite3`.** It normally installs a prebuilt
binary for Node 20/22 on Linux x64. If your build image is unusual, pin the
runtime to Node 22 with a `NIXPACKS_NODE_VERSION=22` variable and redeploy.

**Organizer rights are gone.** They live in a cookie on the device that created
the game. Use the organizer link from the lobby (`/t/CODE/admin?key=…`) to claim
them again — save it somewhere before the tournament starts.

## A note on scale

One Railway service with one volume handles a room full of phones comfortably —
every page is a small server-rendered response and SQLite is local. What it will
not do is scale horizontally: the moment you add a replica, the second container
has no volume and no database. If you ever need that, move `src/db.js` to
Postgres; nothing else in the app depends on SQLite specifically.
