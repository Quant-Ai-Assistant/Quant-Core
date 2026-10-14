# Install a Quant server

[Русская версия](../ru/install.md)

A Quant server runs as a set of Docker containers. One installer downloads the Compose file, asks a few questions and starts everything. Nothing is built on the server: the images come from this repository's releases.

## Requirements

- Linux or macOS with Docker Engine and the Docker Compose plugin. On macOS, Docker Desktop or OrbStack.
- `curl` and `openssl`.
- About 10 GB of free disk space for the images, more for your data.
- A free TCP port for Quant. The installer checks it.

## Run the installer

```sh
mkdir -p quant && cd quant
curl -fsSLO https://raw.githubusercontent.com/Quant-Ai-Assistant/Quant-Core/main/infra/compose/install-images.sh
bash install-images.sh
```

The installer asks four questions:

| Question | What to answer |
| --- | --- |
| Domain for HTTPS | Leave empty for a home network. Enter a domain only if it already points at this server and ports 80 and 443 are free. |
| Port for Quant on this server | Any free port, `8080` by default. A busy port is refused and asked again. |
| Address phones and other computers will use | The server's address on your network, detected automatically, for example `192.168.1.10`. |
| Username and password for the gate | The Basic Auth credentials every device needs. Leave the password empty to get a generated one; it is printed once. |

When it finishes, it prints the address, for example `http://192.168.1.10:8080`, and the gate username.

## What runs

| Service | Role |
| --- | --- |
| `gate` | Caddy with Basic Auth. The only service listening on the network, on the port you chose. |
| `web` | The web interface. Reachable only through the gate (and on `127.0.0.1:5173` on the server itself). |
| `api`, `worker` | The application and its background jobs. |
| `supervisor`, `computer` | The bots' computers: one Docker container per computer. |
| `postgres` | The database. Not published on the host. |
| `updater` | Applies updates from **Settings → Updates**. |

## Files in the install folder

| File | Contents |
| --- | --- |
| `.env` | Every setting and secret, created by the installer with mode `600`. |
| `docker-compose.images.yml` | The services above. |
| `Caddyfile.gate` | The gate configuration. |

Keep `.env` private and back it up: it holds the database password, the encryption key for stored credentials and the gate password hash.

## Non-interactive install

Set the answers as variables and the installer asks nothing:

```sh
QUANT_PORT=8080 QUANT_PUBLIC_HOST=192.168.1.10 \
QUANT_BASIC_USER=quant QUANT_BASIC_PASSWORD='choose-a-password' \
bash install-images.sh
```

Add `QUANT_DOMAIN=quant.example.com` for HTTPS on a domain.

## HTTPS

With a domain, the gate gets a certificate from Let's Encrypt and serves `https://` on port 443. Without one, Quant runs over plain HTTP on your network. In that case:

- the gate password crosses the network unencrypted, so use it only on a network you trust;
- browsers allow the microphone only over HTTPS, so voice features work in the Android app but not in a browser on another device.

## First steps

1. Open the printed address and enter the gate username and password.
2. Create an account. The first account owns the server.
3. Connect a model provider when asked, then create your first bot.

Then connect your phone and desktop: see [Connect the apps](connect.md).
