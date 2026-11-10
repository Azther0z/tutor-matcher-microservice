#!/bin/sh
set -eu
# psql quotes variables as SQL literals; do not interpolate credentials into SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=auth_password="$AUTH_DB_PASSWORD" \
  --set=booking_password="$BOOKING_DB_PASSWORD" \
  --set=wallet_password="$WALLET_DB_PASSWORD" <<'SQL'
CREATE ROLE auth_owner LOGIN PASSWORD :'auth_password';
CREATE ROLE booking_owner LOGIN PASSWORD :'booking_password';
CREATE ROLE wallet_owner LOGIN PASSWORD :'wallet_password';
CREATE DATABASE auth_db OWNER auth_owner;
CREATE DATABASE booking_db OWNER booking_owner;
CREATE DATABASE wallet_db OWNER wallet_owner;
REVOKE ALL ON DATABASE auth_db, booking_db, wallet_db FROM PUBLIC;
GRANT CONNECT ON DATABASE auth_db TO auth_owner;
GRANT CONNECT ON DATABASE booking_db TO booking_owner;
GRANT CONNECT ON DATABASE wallet_db TO wallet_owner;
SQL
