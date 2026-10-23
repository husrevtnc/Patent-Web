#!/bin/sh
set -eu

cd "$(dirname "$0")"

printf 'Ollama Cloud API key (input hidden): ' >&2
trap 'stty echo' EXIT HUP INT TERM
stty -echo
IFS= read -r OLLAMA_API_KEY
stty echo
trap - EXIT HUP INT TERM
printf '\n' >&2

export OLLAMA_API_KEY
exec npm start
