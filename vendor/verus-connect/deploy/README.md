# Deployment templates

Drop-in templates for running `verus-connect` as a per-app sidecar behind nginx
on a Linux box. One unit + one .env + one nginx server block per app you
authenticate.

## Files

| File | What it is |
|---|---|
| `verus-connect-lite-single.service` | systemd unit for **lite mode, single chain** (VRSC). One WIF in the env, one public RPC URL. Most common config. |
| `verus-connect-lite-multi.service` | systemd unit for **lite mode, multi-chain** (VRSC + PBaaS). One WIF in the env, one public RPC URL per chain. |
| `verus-connect-daemon.service` | systemd unit for **daemon mode**. Local verusd(s) hold the signing keys; sidecar reads RPC creds from each chain's `.conf` file. |
| `env.lite-single.example` | Example env for lite-single. Copy, fill in, drop at `/etc/verus-connect/<app>.env`, `chmod 600`. |
| `env.lite-multi.example` | Same, for lite-multi. |
| `env.daemon.example` | Same, for daemon. |
| `nginx-site.conf` | nginx server block — terminates TLS, proxies the `/verus/*` path to the sidecar on `127.0.0.1:PORT`. |

## Install (any mode)

```bash
# 1. The package is checked out (or built dist + node_modules synced) at /opt/verus-connect.
ls /opt/verus-connect/dist/cli.cjs

# 2. Put the per-app env in /etc/verus-connect/<app>.env (mode 600)
sudo install -d -m 750 /etc/verus-connect
sudo install -m 600 env.lite-single.example /etc/verus-connect/myapp.env
sudo vim /etc/verus-connect/myapp.env    # fill in SIGNING_IADDRESS, CALLBACK_URL, PRIVATE_KEY, PORT

# 3. Install the systemd unit (rename to match your app for clarity)
sudo install -m 644 verus-connect-lite-single.service \
  /etc/systemd/system/verus-sidecar-myapp.service
sudo sed -i 's|/etc/verus-connect/CHANGEME.env|/etc/verus-connect/myapp.env|' \
  /etc/systemd/system/verus-sidecar-myapp.service

# 4. Install the nginx server block (one per public host)
sudo install -m 644 nginx-site.conf /etc/nginx/sites-available/myapp.conf
sudo vim /etc/nginx/sites-available/myapp.conf     # set server_name + cert paths + the upstream port
sudo ln -sf /etc/nginx/sites-available/myapp.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. Start
sudo systemctl daemon-reload
sudo systemctl enable --now verus-sidecar-myapp
sudo journalctl -u verus-sidecar-myapp -f
```

## Why this pattern

- **One unit per app.** Each integration gets its own signer identity (see the
  main README's "Why each app needs its own signer"). One unit = one identity.
- **Env in `/etc/verus-connect/`, not in the unit.** Keeps WIFs and RPC
  passwords out of the unit file (which is world-readable). Apps are
  distinguished by which env file they load.
- **No app-specific code in the unit.** Same unit shape across all your sites;
  the env file is the only thing that differs.
- **Per-app nginx server block** so each public host can have its own TLS cert
  + its own CORS origin enforced in the sidecar.

## Picking a port

Pick a unique loopback port per app: 8101, 8102, 8103, … No public exposure —
nginx is the only thing that reaches the sidecar. Set it in the env file
(`PORT=`) and in the nginx upstream.
