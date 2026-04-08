FROM maven:3.9.9-eclipse-temurin-21 AS build

WORKDIR /workspace

COPY pom.xml ./pom.xml
COPY meeting-service/pom.xml ./meeting-service/pom.xml
COPY processing-service/pom.xml ./processing-service/pom.xml
COPY meeting-service/src ./meeting-service/src

RUN mvn -f pom.xml -pl meeting-service -am clean package -DskipTests

FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=build /workspace/meeting-service/target/meeting-service-0.0.1-SNAPSHOT.jar app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
