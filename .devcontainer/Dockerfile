# FayaNMS Codespaces toolchain.
# Bun is pinned to the version used by the repository CI gate.
FROM oven/bun:1.3.14-slim

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dnsutils \
      git \
      gh \
      iproute2 \
      jq \
      netcat-openbsd \
      openssh-client \
      postgresql-client \
      procps \
      ripgrep \
      sudo \
      unzip \
      vim-tiny \
      wget \
 && rm -rf /var/lib/apt/lists/*

# Codespaces normally supplies a non-root remote user. Keep a deterministic
# fallback for local devcontainer clients using this image directly.
RUN if ! id vscode >/dev/null 2>&1; then \
      useradd --create-home --shell /bin/bash --uid 1000 vscode; \
    fi \
 && echo "vscode ALL=(root) NOPASSWD:ALL" >/etc/sudoers.d/vscode \
 && chmod 0440 /etc/sudoers.d/vscode

ENV PATH="/home/vscode/.bun/bin:/root/.bun/bin:${PATH}"
WORKDIR /workspaces/FayaNMS

# Drop privileges as the image's final state — devcontainer.json already sets
# remoteUser: vscode, so this aligns the IMAGE default with the runtime
# contract (semgrep last-user-is-root hardening; apt/root setup above is
# complete, and the vscode user holds passwordless sudo for the rare
# root-needed step).
USER vscode
