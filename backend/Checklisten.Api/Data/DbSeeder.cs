using System.Text.Json;
using Checklisten.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Data;

public static class DbSeeder
{
    public static async Task SeedAsync(IServiceProvider services, IConfiguration cfg, IWebHostEnvironment env, ILogger logger)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Run migrations / create schema
        await db.Database.MigrateAsync();

        // Ensure an admin user exists
        if (!await db.Users.AnyAsync())
        {
            var username = cfg["Seed:AdminUsername"] ?? "admin";
            var password = cfg["Seed:AdminPassword"] ?? "admin";
            var admin = new User
            {
                Username = username,
                DisplayName = "Administrator",
                Role = UserRole.Admin,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            };
            db.Users.Add(admin);
            await db.SaveChangesAsync();
            logger.LogWarning("Seed-Admin angelegt: Benutzer={Username} / Initialpasswort={Password} – bitte umgehend ändern!", username, password);
        }

        // Seed system templates from JSON on first run only
        if (!await db.Templates.AnyAsync())
        {
            var seedPath = Path.Combine(env.ContentRootPath, "seed-templates.json");
            if (File.Exists(seedPath))
            {
                var raw = await File.ReadAllTextAsync(seedPath);
                using var doc = JsonDocument.Parse(raw);
                var inserted = 0;
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    var t = prop.Value;
                    var tpl = new Template
                    {
                        Id        = prop.Name,
                        Title     = t.GetProperty("title").GetString() ?? prop.Name,
                        Subtitle  = t.TryGetProperty("subtitle", out var s) ? s.GetString() : null,
                        Tag       = t.TryGetProperty("tag", out var tg) ? tg.GetString() : null,
                        Meta      = JsonDocument.Parse(t.GetProperty("meta").GetRawText()),
                        Sections  = JsonDocument.Parse(t.GetProperty("sections").GetRawText()),
                        IsSystem  = true,
                    };
                    db.Templates.Add(tpl);
                    inserted++;
                }
                await db.SaveChangesAsync();
                logger.LogInformation("Seed-Vorlagen importiert: {Count}", inserted);
            }
            else
            {
                logger.LogInformation("Keine seed-templates.json gefunden – Datenbank bleibt ohne Vorlagen");
            }
        }
    }
}
