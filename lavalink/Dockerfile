# Self-hosted Lavalink v4 (deploy this folder as its own service, e.g. on Railway).
FROM ghcr.io/lavalink-devs/lavalink:4

COPY application.yml /opt/Lavalink/application.yml

# Keep memory modest for small containers.
ENV _JAVA_OPTIONS="-Xmx768m"

EXPOSE 2333
