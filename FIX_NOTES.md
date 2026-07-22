# Turso and Render deployment

## Turso

1. Create or sign in to a Turso account.
2. Install/login to the Turso CLI when using commands.
3. Create the database:
   `turso db create family-budget-manager`
4. Obtain the URL:
   `turso db show family-budget-manager --url`
5. Create a full-access database token:
   `turso db tokens create family-budget-manager`
6. Save both values securely. The token is a secret.

You can also create the database from an existing SQLite file with:
`turso db create family-budget-manager --from-file ./family-budget.db`

v4.2.0 does not require direct import into Turso because it stores versioned SQLite snapshots. The recommended migration is to restore your v4.0.0 `.db` file from the WebServer interface after both services are deployed.

## Render DBServer

Create a Web Service from the DBServer repository/folder:

- Build: `npm ci --omit=dev`
- Start: `npm start`
- Health check: `/api/health`
- Plan: Free

Environment variables:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `DB_SERVER_SECRET` (generate a long random value)
- `KEEP_SNAPSHOTS=30`

## Render WebServer

Create a second Web Service from the WebServer repository/folder:

- Build: `npm ci --omit=dev`
- Start: `npm start`
- Health check: `/api/health`
- Plan: Free

Environment variables:

- `DB_SERVER_URL=https://<your-dbserver>.onrender.com`
- `DB_SERVER_SECRET` (exactly the same value)
- `APP_INITIAL_PASSWORD`
- `STORAGE_ROOT=/tmp/family-budget`
- `CLOUD_RESTORE_REQUIRED=true`

## Existing v4.0.0 data migration

1. Keep two untouched copies of your v4.0.0 `.db` backup.
2. Open v4.2.0 WebServer.
3. Go to Settings → Database Management.
4. Restore/upload the v4.0.0 `.db` file.
5. WebServer validates SQLite integrity, restores it, uploads it to DBServer/Turso, and restarts.
6. Confirm users, accounts, budgets, transaction counts, balances, income totals, and expense totals.
7. Restart or redeploy WebServer once more and verify the same data returns from Turso.

## Backup model

- The original `.db` remains a valid portable backup.
- Complete ZIP export remains available.
- DBServer retains the latest checksummed snapshots in Turso.
- A checksum and SQLite header are verified on download.
- SQLite integrity is verified before upload and before restore.
