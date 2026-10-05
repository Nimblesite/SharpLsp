FROM mcr.microsoft.com/devcontainers/rust:1-bookworm

# SDK compatibility tests need 9 and the pinned sidecar SDK from ci-analyse.yml.
RUN wget https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet \
    && /tmp/dotnet-install.sh --version 10.0.303 --install-dir /usr/share/dotnet \
    && ln -sf /usr/share/dotnet/dotnet /usr/bin/dotnet \
    && rm /tmp/dotnet-install.sh

ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"

# GitHub Actions local runner (keep version in sync with .github/workflows/ci.yml)
RUN curl -fsSL https://raw.githubusercontent.com/nektos/act/master/install.sh | bash -s -- -b /usr/local/bin

# .NET diagnostic tools for profiler integration
RUN dotnet tool install -g dotnet-trace \
    && dotnet tool install -g dotnet-counters \
    && dotnet tool install -g dotnet-dump
ENV PATH="${PATH}:/root/.dotnet/tools"

# Rust components
RUN rustup component add clippy rustfmt
