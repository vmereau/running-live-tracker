# Tailscale Funnel: exposing the server to spectators

The server binds `127.0.0.1:8787` only (AD-11). The only public path is Tailscale
Funnel on port 443, which terminates TLS on the tailnet node and proxies to
localhost. There is no tunnel-specific code in the server. Cloudflare Quick
Tunnels, port forwarding and raw public IPs are forbidden.

This note also records the Story 1.2 spike: does a long-lived SSE stream
(`GET /api/v1/live`) survive Funnel to a phone on mobile data? The answer decides
Story 1.6's transport: SSE, or polling `GET /api/v1/snapshot` every 5 s.

## Prerequisites

- Tailscale installed on the home PC and logged in to the tailnet. Check with
  `tailscale status`. The spike was prepared with Tailscale **1.98.4** (the spine
  pins 1.104.1; Funnel exists in both, and upgrading is out of scope for 1.2).
- In the Tailscale admin console:
  - **DNS**: MagicDNS and **HTTPS certificates** enabled.
  - **Access controls**: the `funnel` node attribute granted to this machine.
    The first `tailscale funnel` run prints a link to enable it if it is missing.
- The server built and running locally:

  ```sh
  pnpm install
  pnpm --filter web build          # the diagnostic page served at /
  EVENT_CONFIG=config/event.example.json pnpm dev        # Git Bash
  ```

  ```powershell
  $env:EVENT_CONFIG='config/event.example.json'; pnpm dev  # PowerShell
  ```

  Check it locally first: `curl -N http://127.0.0.1:8787/api/v1/live` prints an
  `event: snapshot` frame at once, then `: ping` every 20 s.

## Commands

Run these in a terminal on the home PC (PowerShell or Git Bash).

| What | Command |
| --- | --- |
| Start (foreground, stops on Ctrl+C) | `tailscale funnel 8787` |
| Start (background, survives the terminal) | `tailscale funnel --bg 8787` |
| Status and public URL | `tailscale funnel status` |
| Stop a background funnel | `tailscale funnel --https=443 off` (or `tailscale funnel reset` to clear all serve/funnel config) |

`tailscale funnel 8787` proxies `https://<machine>.<tailnet>.ts.net/` (port 443)
to `http://127.0.0.1:8787`. The server keeps listening on localhost only.

## URL shape

```
https://<machine-name>.<tailnet-name>.ts.net/                  diagnostic page (later: the live map)
https://<machine-name>.<tailnet-name>.ts.net/api/v1/live       SSE stream
https://<machine-name>.<tailnet-name>.ts.net/api/v1/snapshot   snapshot JSON (polling fallback)
https://<machine-name>.<tailnet-name>.ts.net/api/v1/health     health check
```

`tailscale funnel status` prints the exact hostname. DNS for a new Funnel name can
take a few minutes to propagate.

## Running the phone test

1. Start the server and the funnel as above. From another network, check
   `curl -N https://<host>.ts.net/api/v1/live` shows the snapshot and then pings.
2. On the phone, **turn Wi-Fi off** so it uses mobile data, and make sure it is
   not on the tailnet (Tailscale app off), so traffic really goes through Funnel.
3. Open `https://<host>.ts.net/`. Keep the screen on and the browser in the
   foreground for **at least 5 minutes**.
4. Read the diagnostic page:
   - **EventSource**: state should stay `open`, *Opens* 1, *Errors* 0,
     *Snapshots* 1. Each extra open or error means a reconnect.
   - **Raw stream**: *Connected for* keeps counting past 5 min, *Reconnects* 0,
     *Pings* ~15 after 5 min, *Max gap* ~20 s. Gaps over 25 s turn red in the
     frame list.
   - Pings arriving in bursts (several at once after a long gap) mean something
     on the path buffers the stream.
5. Take a screenshot of the page at the end and note the phone, browser and
   carrier.
6. Optional: lock the phone for a minute, unlock it, and note whether the page
   reconnects by itself (the EventSource *Opens* counter goes up and a new
   snapshot arrives).

## Outcome

<!-- Filled in after the human runs the phone test (Story 1.2). -->

- Date:
- Tailscale version:
- Phone / browser / carrier:
- Duration kept open:
- Snapshot received:
- Pings (count, typical gap, max gap):
- Disconnects / reconnects:
- Buffering observed:
- **Decision for Story 1.6:** SSE works / polling fallback needed
