FROM node:20 AS build

WORKDIR /workspace/FE-Audiomind
COPY FE-Audiomind/package*.json ./
RUN rm -f package-lock.json
RUN npm install

WORKDIR /workspace
COPY FE-Audiomind ./FE-Audiomind
COPY packages ./packages

WORKDIR /workspace/FE-Audiomind
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /workspace/FE-Audiomind/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
