# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore
COPY backend/Checklisten.Api/Checklisten.Api.csproj backend/Checklisten.Api/
RUN dotnet restore backend/Checklisten.Api/Checklisten.Api.csproj

# Build & publish
COPY backend/ backend/
RUN dotnet publish backend/Checklisten.Api/Checklisten.Api.csproj -c Release -o /app/publish /p:UseAppHost=false

# Frontend assets get copied into wwwroot inside the published app
COPY frontend/ /app/publish/wwwroot/

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish ./
# Stamp the build version into the image so /api/version doesn't have to read a file at runtime.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Checklisten.Api.dll"]
