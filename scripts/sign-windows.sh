#!/bin/sh
# Authenticode-signs a Windows binary with Azure Artifact Signing (formerly Trusted Signing) through jsign.
# Called by GoReleaser after each build; does nothing for other OSes or when the credentials are unset.
#   AZURE_SIGNING_ENDPOINT  e.g. eus.codesigning.azure.net
#   AZURE_SIGNING_ACCOUNT   Artifact Signing account name
#   AZURE_SIGNING_PROFILE   certificate profile name
#   AZURE_SIGNING_TOKEN     access token (az account get-access-token --resource https://codesigning.azure.net)
set -eu
binary="$1"
os="$2"
[ "$os" = windows ] || exit 0
if [ -z "${AZURE_SIGNING_TOKEN:-}" ]; then
  echo "sign-windows: AZURE_SIGNING_TOKEN is not set; leaving $binary unsigned"
  exit 0
fi
jsign --storetype TRUSTEDSIGNING \
  --keystore "$AZURE_SIGNING_ENDPOINT" \
  --storepass "$AZURE_SIGNING_TOKEN" \
  --alias "$AZURE_SIGNING_ACCOUNT/$AZURE_SIGNING_PROFILE" \
  --tsaurl http://timestamp.acs.microsoft.com/ --tsmode RFC3161 \
  "$binary"
