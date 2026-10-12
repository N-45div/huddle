# Builds Huddle for Linux (.deb and AppImage) on Ubuntu 22.04, so the app also runs on older distributions.
#
#   docker build -t huddle-linux-build packages/desktop/linux
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/packages/desktop/dist:/out" \
#     -v huddle-cargo:/root/.cargo/registry -v huddle-target:/build/packages/desktop/src-tauri/target \
#     huddle-linux-build
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git pkg-config rsync xz-utils xdg-utils \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24.11.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt \
 && for tool in node npm npx; do ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/${tool}" "/usr/local/bin/${tool}"; done

ARG RUST_VERSION=1.97.1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"

# linuxdeploy runs as an AppImage itself; containers have no FUSE.
ENV PATH=/root/.cargo/bin:$PATH APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true
WORKDIR /build
COPY build.sh /usr/local/bin/huddle-build
RUN chmod +x /usr/local/bin/huddle-build
ENTRYPOINT ["huddle-build"]
