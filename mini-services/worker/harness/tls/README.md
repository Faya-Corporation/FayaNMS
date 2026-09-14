# TLS material for the SFOS WebAPI harness — TEST-ONLY

`sfos-webapi-cert.pem` / `sfos-webapi-key.pem` are a self-signed loopback
certificate (CN=localhost, SAN DNS:localhost / IP:127.0.0.1) used ONLY by
the in-repo SFOS WebAPI protocol harness (`../sfos-webapi.ts`).

- This is committed test material, generated for the certification harness.
  It signs NOTHING production-related and must never be deployed.
- The certification uses it to prove the transport's fail-closed TLS
  posture: without `FAYANMS_WEBAPI_CA_PEM` set to this certificate the
  transport must refuse the connection BEFORE any credential is sent, and
  with it set, the full TLS + request + response flow must succeed.
- Regenerate (e.g. after expiry) with:
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout sfos-webapi-key.pem -out sfos-webapi-cert.pem -days 3650 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`
