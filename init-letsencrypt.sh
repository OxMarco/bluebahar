#!/usr/bin/env bash
# Bootstrap Let's Encrypt certificates for the production stack.
# Run this once on a fresh server before `docker compose -f docker-compose.prod.yaml up -d`.
#
# Required env (loaded from .env.prod by docker compose, but read here from your shell):
#   DOMAIN       - public hostname, e.g. api.example.com
#   ACME_EMAIL   - contact email for Let's Encrypt
#   STAGING      - 1 to use the LE staging endpoint (recommended for first run), 0 for real certs

set -euo pipefail

if ! [ -x "$(command -v docker)" ]; then
  echo 'Error: docker is required.' >&2
  exit 1
fi

: "${DOMAIN:?DOMAIN must be set, e.g. export DOMAIN=api.example.com}"
: "${ACME_EMAIL:?ACME_EMAIL must be set}"
STAGING="${STAGING:-1}"

COMPOSE="docker compose -f docker-compose.prod.yaml"
DATA_PATH="./certbot"
RSA_KEY_SIZE=4096

if [ -d "$DATA_PATH/conf/live/$DOMAIN" ]; then
  read -r -p "Existing certificates found for $DOMAIN. Replace them? (y/N) " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    exit 0
  fi
fi

if [ ! -e "$DATA_PATH/conf/options-ssl-nginx.conf" ] || [ ! -e "$DATA_PATH/conf/ssl-dhparams.pem" ]; then
  echo "### Downloading recommended TLS parameters ..."
  mkdir -p "$DATA_PATH/conf"
  curl -sL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf > "$DATA_PATH/conf/options-ssl-nginx.conf"
  curl -sL https://ssl-config.mozilla.org/ffdhe2048.txt > "$DATA_PATH/conf/ssl-dhparams.pem"
fi

echo "### Creating dummy certificate for $DOMAIN ..."
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"
mkdir -p "$DATA_PATH/conf/live/$DOMAIN"
$COMPOSE run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$RSA_KEY_SIZE -days 1 \
    -keyout '$CERT_PATH/privkey.pem' \
    -out '$CERT_PATH/fullchain.pem' \
    -subj '/CN=localhost'" certbot
# chain.pem is referenced by nginx's ssl_trusted_certificate; reuse fullchain for the dummy.
cp "$DATA_PATH/conf/live/$DOMAIN/fullchain.pem" "$DATA_PATH/conf/live/$DOMAIN/chain.pem"

echo "### Starting nginx ..."
$COMPOSE up --force-recreate -d nginx

echo "### Deleting dummy certificate for $DOMAIN ..."
$COMPOSE run --rm --entrypoint "\
  rm -Rf /etc/letsencrypt/live/$DOMAIN && \
  rm -Rf /etc/letsencrypt/archive/$DOMAIN && \
  rm -Rf /etc/letsencrypt/renewal/$DOMAIN.conf" certbot

echo "### Requesting Let's Encrypt certificate for $DOMAIN ..."
STAGING_ARG=""
if [ "$STAGING" != "0" ]; then STAGING_ARG="--staging"; fi

$COMPOSE run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $STAGING_ARG \
    --email $ACME_EMAIL \
    -d $DOMAIN \
    --rsa-key-size $RSA_KEY_SIZE \
    --agree-tos \
    --non-interactive \
    --force-renewal" certbot

echo "### Reloading nginx ..."
$COMPOSE exec nginx nginx -s reload

echo
echo "Done. If STAGING=1 was used, re-run with STAGING=0 to obtain a trusted certificate."
