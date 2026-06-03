using System.Text.Json;
using Checklisten.Api.Auth;
using Checklisten.Api.Data;
using Checklisten.Api.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Endpoints;

public static class TemplateEndpoints
{
    public sealed record TemplateDto(
        string Id, string Title, string? Subtitle, string? Tag,
        JsonElement Meta, JsonElement Sections,
        bool IsSystem, DateTime UpdatedAt);

    public sealed record TemplateUpsertDto(
        string Id, string Title, string? Subtitle, string? Tag,
        JsonElement Meta, JsonElement Sections);

    public static IEndpointRouteBuilder MapTemplateEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/templates").RequireAuthorization("AnyAuthenticated");

        grp.MapGet("/", async (AppDbContext db) =>
        {
            var entities = await db.Templates
                .Where(t => t.DeletedAt == null)
                .OrderBy(t => t.IsSystem ? 0 : 1).ThenBy(t => t.Title)
                .ToListAsync();
            var list = entities.Select(t => new TemplateDto(t.Id, t.Title, t.Subtitle, t.Tag,
                t.Meta.RootElement, t.Sections.RootElement, t.IsSystem, t.UpdatedAt));
            return Results.Ok(list);
        });

        grp.MapPut("/{id}", async (string id, [FromBody] TemplateUpsertDto dto, AppDbContext db, HttpContext http) =>
        {
            if (!http.User.CanEditTemplates())
                return Results.Json(new { error = "forbidden" }, statusCode: 403);
            if (id != dto.Id) return Results.BadRequest(new { error = "id_mismatch" });
            if (string.IsNullOrWhiteSpace(dto.Title)) return Results.BadRequest(new { error = "title_required" });

            var meta     = JsonDocument.Parse(dto.Meta.GetRawText());
            var sections = JsonDocument.Parse(dto.Sections.GetRawText());

            var existing = await db.Templates.FindAsync(id);
            if (existing is null)
            {
                existing = new Template { Id = id, IsSystem = false };
                db.Templates.Add(existing);
            }
            else if (existing.IsSystem && http.User.Role() != UserRole.Admin)
            {
                return Results.Json(new { error = "system_template_admin_only" }, statusCode: 403);
            }

            existing.Title    = dto.Title.Trim();
            existing.Subtitle = string.IsNullOrWhiteSpace(dto.Subtitle) ? null : dto.Subtitle.Trim();
            existing.Tag      = string.IsNullOrWhiteSpace(dto.Tag)      ? null : dto.Tag.Trim();
            existing.Meta     = meta;
            existing.Sections = sections;
            existing.DeletedAt = null;
            existing.UpdatedAt = DateTime.UtcNow;

            await db.SaveChangesAsync();
            return Results.Ok(new TemplateDto(existing.Id, existing.Title, existing.Subtitle, existing.Tag,
                existing.Meta.RootElement, existing.Sections.RootElement, existing.IsSystem, existing.UpdatedAt));
        });

        grp.MapDelete("/{id}", async (string id, AppDbContext db, HttpContext http) =>
        {
            if (!http.User.CanEditTemplates())
                return Results.Json(new { error = "forbidden" }, statusCode: 403);

            var t = await db.Templates.FindAsync(id);
            if (t is null) return Results.NotFound();
            if (t.IsSystem && http.User.Role() != UserRole.Admin)
                return Results.Json(new { error = "system_template_admin_only" }, statusCode: 403);

            // Soft delete so historical sessions still resolve their template snapshot.
            t.DeletedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        return app;
    }
}
