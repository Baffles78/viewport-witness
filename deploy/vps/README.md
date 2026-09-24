# VPS deployment notes

Target: `qa.honeygate.app` on the existing HoneyGate VPS.

The application binds only to `127.0.0.1:3402`. Nginx is the public entry point.
The browser container has a fixed private subnet, and `viewport-witness-egress`
blocks private, reserved, metadata, and same-VPS destinations independently of
the application URL checks.

Protected values belong in `/etc/viewport-witness/viewport-witness.env`, owned by
root with mode `0600`. Never copy that file into the repository or container image.

Installation order:

1. Install Docker Engine and the Compose plugin from the Ubuntu repository.
   Keep Docker IPv6 disabled in `/etc/docker/daemon.json`; the Compose network
   and container also disable IPv6 independently.
2. Place the exact reviewed repository at `/opt/viewport-witness`.
3. Create the protected environment file from `viewport-witness.env.example`.
4. Install the egress script, both systemd units, and the Docker service drop-in.
5. Build once with `docker compose -f deploy/docker-compose.vps.yml build`.
6. Start `viewport-witness-egress`, then `viewport-witness`.
7. Install the Nginx vhost and both Cloudflare snippets, run `nginx -t`, and reload Nginx.
8. Add the proxied Cloudflare DNS record for `qa.honeygate.app`.
9. Verify origin health, public TLS, payment discovery, 402 behavior, and a paid
   Base Sepolia request before considering mainnet.

Mainnet remains a separate release. It requires an exact-source review, changing
both `PAYMENT_MODE` and `ENABLE_MAINNET_PAYMENTS`, and a real $0.08 smoke payment.

## Rollback

Before an update, tag the running image with a dated backup tag. To roll back,
stop the service, restore the previous reviewed commit and image tag, then start
the service and repeat the origin/public smoke checks. Named data volumes are not
removed by `docker compose down`.

To remove only this service's egress hook, stop `viewport-witness`, disable the
egress unit, delete the source-subnet jump from `DOCKER-USER`, then delete the
empty `VW-EGRESS` chain. Never flush `DOCKER-USER`; it may contain unrelated
rules. After any Docker or firewall reload, rerun the egress script and verify a
private-address request is blocked before restarting the application.
