#!/usr/bin/env bash
set -euo pipefail

source_subnet="172.31.250.0/24"
chain="VW-EGRESS"

iptables -w -N "$chain" 2>/dev/null || true
iptables -w -F "$chain"

# Block destinations that a public browser-QA worker must never reach.
blocked_ipv4=(
  "0.0.0.0/8"
  "10.0.0.0/8"
  "100.64.0.0/10"
  "127.0.0.0/8"
  "169.254.0.0/16"
  "172.16.0.0/12"
  "192.0.0.0/24"
  "192.0.2.0/24"
  "192.168.0.0/16"
  "198.18.0.0/15"
  "198.51.100.0/24"
  "203.0.113.0/24"
  "224.0.0.0/4"
  "240.0.0.0/4"
)

for cidr in "${blocked_ipv4[@]}"; do
  iptables -w -A "$chain" -d "$cidr" -j REJECT
done

# Block every current global IPv4 address on this VPS, including future
# secondary/floating addresses, so the worker cannot loop back through public DNS.
while read -r host_ip; do
  test -n "$host_ip" && iptables -w -A "$chain" -d "$host_ip/32" -j REJECT
done < <(ip -4 -o addr show scope global | awk '{split($4, address, "/"); print address[1]}')

iptables -w -A "$chain" -j RETURN

iptables -w -C DOCKER-USER -s "$source_subnet" -j "$chain" 2>/dev/null || \
  iptables -w -I DOCKER-USER 1 -s "$source_subnet" -j "$chain"
