#!/bin/sh
set -eu

root="${1:?repository root is required}"
output="${2:?output directory is required}"

test -d "${root}/node_modules/@prisma/engines"

rm -rf "${output}"
mkdir -p "${output}/bin" "${output}/lib"

openssl_path="$(command -v openssl)"
test -x "${openssl_path}"
cp -L "${openssl_path}" "${output}/bin/openssl"
chmod 0755 "${output}/bin/openssl"

for library_name in libgcc_s.so.1 libssl.so.3 libcrypto.so.3 libz.so.1 libstdc++.so.6; do
  library_path="$(find /lib /usr/lib -type f -name "${library_name}" -print -quit)"
  if [ -n "${library_path}" ]; then
    cp -L "${library_path}" "${output}/lib/${library_name}"
  fi
done

test -s "${output}/lib/libgcc_s.so.1"
test -s "${output}/lib/libssl.so.3"
test -s "${output}/lib/libcrypto.so.3"
