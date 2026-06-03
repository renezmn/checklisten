using System.Net.Http;
using Checklisten.Api.Auth;
using Microsoft.Extensions.Hosting;

namespace Checklisten.Api.Endpoints;

public static class UpdateEndpoints
{
    public sealed record VersionInfo(string current, string? available, bool updateAvailable, DateTime? requestedAt);

    // Resolve the version that this build/process represents.
    // Preference order: env var APP_VERSION → file VERSION next to ContentRoot or one level up → "dev".
    public static string ReadCurrentVersion(IConfiguration cfg, IHostEnvironment env)
    {
        var fromCfg = cfg["AppVersion"] ?? Environment.GetEnvironmentVariable("APP_VERSION");
        if (!string.IsNullOrWhiteSpace(fromCfg)) return fromCfg.Trim();

        foreach (var candidate in new[] {
            Path.Combine(env.ContentRootPath, "VERSION"),
            Path.Combine(env.ContentRootPath, "..", "VERSION"),
            Path.Combine(env.ContentRootPath, "..", "..", "VERSION"),
        })
        {
            try
            {
                var full = Path.GetFullPath(candidate);
                if (File.Exists(full))
                    return File.ReadAllText(full).Trim();
            }
            catch { /* ignore */ }
        }
        return "dev";
    }

    public static IEndpointRouteBuilder MapUpdateEndpoints(this IEndpointRouteBuilder app)
    {
        // Public version probe – cheap call the frontend uses for the staleness banner / version display.
        app.MapGet("/api/version", (IConfiguration cfg, IWebHostEnvironment env) =>
        {
            return Results.Ok(new { version = ReadCurrentVersion(cfg, env) });
        });

        var grp = app.MapGroup("/api/admin").RequireAuthorization("Admin");

        // Check whether a newer version is available at the configured remote URL.
        grp.MapGet("/update-info", async (IConfiguration cfg, IWebHostEnvironment env, IHttpClientFactory hcf) =>
        {
            var current = ReadCurrentVersion(cfg, env);
            string? available = null;
            string? error = null;
            var url = cfg["Update:VersionUrl"];
            if (!string.IsNullOrWhiteSpace(url))
            {
                try
                {
                    using var http = hcf.CreateClient();
                    http.Timeout = TimeSpan.FromSeconds(8);
                    var raw = await http.GetStringAsync(url);
                    available = raw.Trim();
                }
                catch (Exception ex) { error = ex.Message; }
            }

            // Is an update already requested? (flag-file path)
            DateTime? requestedAt = null;
            var flag = cfg["Update:FlagFile"];
            if (!string.IsNullOrWhiteSpace(flag) && File.Exists(flag))
                requestedAt = File.GetLastWriteTimeUtc(flag);

            var updateAvailable = !string.IsNullOrEmpty(available)
                && !string.Equals(available, current, StringComparison.OrdinalIgnoreCase);

            return Results.Ok(new {
                current,
                available,
                updateAvailable,
                requestedAt,
                versionUrl = url,
                flagFile = string.IsNullOrWhiteSpace(flag) ? null : flag,
                error,
            });
        });

        // Trigger an update – just writes a flag file. A host-side watcher (cron/systemd timer)
        // is expected to pick it up and run scripts/update.sh.
        grp.MapPost("/trigger-update", (IConfiguration cfg) =>
        {
            var flag = cfg["Update:FlagFile"];
            if (string.IsNullOrWhiteSpace(flag))
                return Results.BadRequest(new { error = "update_not_configured", detail = "Update:FlagFile ist nicht gesetzt – Update-Trigger nicht möglich." });
            try
            {
                var dir = Path.GetDirectoryName(flag);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(flag, DateTime.UtcNow.ToString("O") + "\n");
                return Results.Ok(new { requestedAt = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = "flag_write_failed", detail = ex.Message }, statusCode: 500);
            }
        });

        return app;
    }
}
