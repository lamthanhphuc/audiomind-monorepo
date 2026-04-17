# syntax=docker/dockerfile:1.7-labs
FROM maven:3.9.9-eclipse-temurin-21 AS build

WORKDIR /workspace

COPY pom.xml ./pom.xml
COPY meeting-service/pom.xml ./meeting-service/pom.xml
COPY processing-service/pom.xml ./processing-service/pom.xml
COPY user-service/pom.xml ./user-service/pom.xml
COPY meeting-service/src ./meeting-service/src

RUN --mount=type=cache,target=/root/.m2 \
    mvn -f pom.xml -pl meeting-service -am clean package -DskipTests

FROM eclipse-temurin:21-jre

WORKDIR /app

RUN groupadd -g 10001 app && useradd -u 10001 -g app -m app

COPY --from=build --chown=10001:10001 /workspace/meeting-service/target/meeting-service-0.0.1-SNAPSHOT.jar app.jar

USER 10001

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
