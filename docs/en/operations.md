# Operations

[Русская версия](../ru/operations.md)

Commands in this guide run in the install folder, the one that holds `.env`. Most use this prefix:

```sh
dc() { docker compose --env-file .env -f docker-compose.images.yml "$@"; }
```

## Status and logs

```sh
dc ps            # every service and its health
dc logs -f api   # follow one service's log
```

## Stop and start

```sh
dc down          # stop and remove the containers, keep the data
dc up -d         # start again
```

## Change the gate password

Delete the gate lines from `.env` and run the installer again: it keeps everything else and asks only for the gate settings.

```sh
sed -i.bak '/^QUANT_BASIC_HASH=/d;/^QUANT_GATE_TOKEN=/d' .env
bash install-images.sh
```

Every device then needs the new password. Removing `QUANT_GATE_TOKEN` also signs out the browsers and apps that passed the gate before.

## Change the port

Set `QUANT_PORT` and the port in `WEB_ORIGIN`, `BETTER_AUTH_URL` and `API_URL` in `.env`, then run `dc up -d`. Update the address in the apps.

## Backups

Everything lives in two Docker volumes, `quant_pgdata` (the database) and `quant_appdata` (files), plus `.env`. A database dump:

```sh
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > quant-$(date +%F).sql
```

Restore it into an empty database with `psql` in the same container. Keep `.env` with the dump: without `ENCRYPTION_KEY` the stored provider keys cannot be read.

## Remove Quant

```sh
dc down -v       # also deletes the database and files
```

Then delete the install folder.

## Security notes

- **The updater holds the Docker socket**, which equals root on the host. It listens only on a private network that the `api` service can reach.
- **Plain HTTP** sends the gate password unencrypted. Use a domain with HTTPS, a VPN or a trusted network.
- **Open sign-up** is on by default: anyone who passes the gate can create an account. Set `SIGNUPS_ENABLED=false` in `.env` after you create yours and run `dc up -d`.
