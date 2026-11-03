# SPDX-License-Identifier: Apache-2.0
# The shared computer image (M4-04 AC5, M4-05 AC1; owned by M4-05 until M4-04 lands): the only
# image a computer boots. Pinned by digest (see pins.json), reproducible from this file plus
# the pins — no floating tag, no `latest`, at runtime the adapters reference the digest only.
#
# Contents are the task runtime, not the agent: git (clone the genuine task), node + npm
# (run its tests), and nothing else. Credentials never enter the image (M4-00 §4.0): the
# capability token rides the control channel into the bridge process's memory only, and no
# session cookie, model key or wider-audience token is baked, mounted or injected.
#
# Build: docker build -f computers/image/Dockerfile --build-arg BASE_DIGEST=<digest>
#   --build-arg GIT_VERSION=<version> --build-arg NODE_MAJOR=<major> -t <ref> computers/image
# The M4-05 docker-gated tests build from this file and assert the pins match pins.json.
ARG BASE_DIGEST=sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
FROM node:22-alpine@${BASE_DIGEST}
ARG GIT_VERSION=2.54.0-r0
RUN apk add --no-cache git=${GIT_VERSION} && \
    adduser -D -u 10000 computer && \
    mkdir -p /work && chown computer:computer /work
USER 10000
WORKDIR /work
