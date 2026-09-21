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

libgcc_path="$(find /lib /usr/lib -type f -name 'libgcc_s.so.1' -print -quit)"
test -n "${libgcc_path}"
cp -L "${libgcc_path}" "${output}/lib/libgcc_s.so.1"

deps_file="$(mktemp)"
trap 'rm -f "${deps_file}"' EXIT

{
  printf '%s\n' "${openssl_path}"
  find "${root}/node_modules/@prisma/engines" -type f \( -name '*linux*' -o -name 'schema-engine*' \) -print
} | while IFS= read -r target; do
  [ -f "${target}" ] || continue
  ldd "${target}" 2>/dev/null || true
done | awk '
  $1 ~ /^\// { print $1 }
  $3 ~ /^\// { print $3 }
' | sort -u > "${deps_file}"

while IFS= read -r lib; do
  [ -n "${lib}" ] || continue
  case "${lib}" in
    */libc.so.*|*/libm.so.*|*/libpthread.so.*|*/librt.so.*|*/libdl.so.*|*/ld-linux-*.so.*|*/ld-musl-*.so.*)
      continue
      ;;
  esac
  cp -L "${lib}" "${output}/lib/$(basename "${lib}")"
done < "${deps_file}"

test -s "${output}/lib/libgcc_s.so.1"
