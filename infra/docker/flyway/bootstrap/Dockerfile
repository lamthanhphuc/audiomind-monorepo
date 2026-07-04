FROM flyway/flyway:10.22.0-alpine

RUN apk add --no-cache postgresql-client \
    && mkdir -p /flyway/sql

COPY infra/docker/flyway/db-flyway-bootstrap.sh /flyway/db-flyway-bootstrap.sh

RUN sed -i 's/\r$//' /flyway/db-flyway-bootstrap.sh \
    && chmod +x /flyway/db-flyway-bootstrap.sh

ENTRYPOINT ["/bin/sh", "/flyway/db-flyway-bootstrap.sh"]
