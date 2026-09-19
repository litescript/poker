# pokerpot

Shared chip ledger and live pot tracker for a home game. One page, open on
everyone's phone, all looking at the same table.

- **Table** — the live pot, seat by seat: blinds, bets, folds, all-ins and side
  pots. An action dock shows Fold / Check-Call / Bet-Raise for whoever's turn it
  is, with min / ½-pot / pot / all-in shortcuts.
- **Ledger** — buy-ins and rebuys, sit out and sit back in, cash out, add someone
  who turned up late. A chip audit flags when counts have drifted.
- **Settle** — net per player, then the fewest transfers that clear the night.

## Run it

```sh
PORT=8082 POKERPOT_PIN=4242 node server.mjs
```

No dependencies. Everyone on the wifi opens the URL and types the PIN once.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | set `127.0.0.1` when behind a reverse proxy |
| `POKERPOT_PIN` | *(unset)* | when unset, anyone with the URL can act |
| `POKERPOT_BASE` | `/` | mount point, e.g. `/poker` for `litescript.net/poker` |
| `POKERPOT_STATE` | `./data/table.json` | where the table is saved |

State is one JSON file, written atomically, reloaded on restart — a crash
mid-session loses nothing.

## Behind Caddy, at a subpath

Serving it at `litescript.net/poker` needs no DNS record. Add this inside your
existing site block:

```caddy
litescript.net {
	handle_path /poker* {
		reverse_proxy 127.0.0.1:8082
	}

	# ... your existing handlers ...
}
```

and run the app with a matching `POKERPOT_BASE`:

```sh
PORT=8082 HOST=127.0.0.1 POKERPOT_BASE=/poker POKERPOT_PIN=4242 node server.mjs
```

`handle_path` strips the prefix before proxying. `POKERPOT_BASE` is what the
server injects into the page so the browser builds `/poker/api/...` URLs rather
than guessing from the address bar — which is what breaks a subpath app when
someone types the URL without a trailing slash. The server accepts the prefix
stripped or intact, so a plain `handle` works too.

That's the whole proxy config: `reverse_proxy` detects `text/event-stream` and
flushes each event straight through, so the live table needs no streaming
tweaks, and Caddy handles TLS on its own.

<details><summary>nginx instead</summary>

nginx buffers SSE by default and the table will look frozen until a flush:

```nginx
location /poker/ {
    proxy_pass         http://127.0.0.1:8082/;
    proxy_http_version 1.1;
    proxy_set_header   Connection "";
    proxy_buffering    off;
    proxy_read_timeout 1h;
}
```
</details>

As a service, from a clone at `/srv/poker`:

```sh
sudo cp pokerpot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pokerpot
```

The unit runs as root out of `/srv/poker` and sets no `User=`, since root is
the default. Change `POKERPOT_PIN`, or drop the line to skip the prompt.

Use `cp -f` — without it, an existing unit is left in place and systemd keeps
running the old one. A unit that fails with `217/USER` is naming a user that
doesn't exist on the box; check the file in `/etc/systemd/system/`, not the one
in the repo.

`ExecStart` uses the absolute `/usr/bin/node` rather than `/usr/bin/env node`,
because units run with a minimal `PATH` that won't find an nvm-installed Node.

## Layout

```
index.html         the whole app — engine, UI and sync, one file
server.mjs         sync server: static page, SSE push, JSON persistence
Caddyfile          reverse proxy config
test/engine.test.mjs   known-answer checks for the betting engine
```

`index.html` picks its sync transport at boot: the server's `/api` if it's
there, otherwise the claude.ai artifact db, otherwise this-device-only
localStorage. So the same file runs self-hosted or as an artifact.

## Tests

```sh
node test/engine.test.mjs
```

Covers blind posting (including heads-up, where the button posts the small
blind), action order, street advance, min-raise and re-opened action, side pots
from uneven all-ins, dead money from folded players, odd-chip rounding on split
pots, and settlement balancing to zero.

## Known limits

- Writes are last-write-wins guarded by a revision number: if two people act at
  the same instant, one gets "someone else acted first" and re-renders. Fine for
  a real table where one person acts at a time.
- The PIN is a speed bump, not authentication. Don't put real money in it.
- `/api/health` answers without the PIN (rev number and viewer count only).
