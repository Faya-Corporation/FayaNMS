-- CreateTable
-- SAFE-001 (audit P0-001): SSH host-key enrollment + pinning. One pinned
-- key per SSH endpoint (host+port — the known_hosts model). The worker
-- transport refuses any LIVE connection whose presented host key does not
-- match the pinned fingerprint (SSH_HOSTKEY_MISMATCH) and refuses LIVE
-- connections without an enrollment entirely (SSH_HOSTKEY_UNENROLLED),
-- except on the audited enrollment probe. Fingerprint format is the
-- OpenSSH-style "SHA256:<base64, no padding>" of the public key blob.
CREATE TABLE "SshHostKey" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "keyType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "hostKeyBase64" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledBy" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "SshHostKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SshHostKey_host_port_key" ON "SshHostKey"("host", "port");

-- CreateIndex
CREATE INDEX "SshHostKey_host_idx" ON "SshHostKey"("host");
