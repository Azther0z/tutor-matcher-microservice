#!/bin/sh
set -eu

if [ -n "${GATEWAY_WORKLOAD_CREDENTIAL_FILE:-}" ]; then
  if [ -n "${GATEWAY_WORKLOAD_CREDENTIAL:-}" ]; then
    printf '%s\n' 'gateway credential must be set inline or by file, not both' >&2
    exit 1
  fi
  if [ ! -r "$GATEWAY_WORKLOAD_CREDENTIAL_FILE" ]; then
    printf '%s\n' 'gateway credential file is not readable' >&2
    exit 1
  fi
  GATEWAY_WORKLOAD_CREDENTIAL=$(cat -- "$GATEWAY_WORKLOAD_CREDENTIAL_FILE")
  export GATEWAY_WORKLOAD_CREDENTIAL
fi

if [ -z "${GATEWAY_WORKLOAD_CREDENTIAL:-}" ]; then
  printf '%s\n' 'gateway workload credential is required' >&2
  exit 1
fi

exec traefik "$@"
