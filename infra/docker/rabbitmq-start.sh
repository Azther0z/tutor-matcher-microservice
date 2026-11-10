#!/bin/sh
set -eu
export RABBITMQ_DEFAULT_PASS="$(cat /run/secrets/rabbitmq_password)"
exec /usr/local/bin/docker-entrypoint.sh rabbitmq-server
