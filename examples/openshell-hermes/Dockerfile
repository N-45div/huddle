# Hermes Agent for an OpenShell sandbox: a single-platform image that runs as a normal user (OpenShell
# won't run a workload as root), with Hermes' state in a folder that user can write.
FROM nousresearch/hermes-agent:latest
RUN (id -u 1000 >/dev/null 2>&1 || useradd -m -u 1000 -s /bin/sh agent) \
 && mkdir -p /tmp/hermes && chown 1000:1000 /tmp/hermes \
 && chmod -R a+rX /opt/hermes
ENV HERMES_HOME=/tmp/hermes
# OpenShell checks the workspace (the working directory) is writable by the sandbox's user.
WORKDIR /tmp/hermes
USER 1000:1000
