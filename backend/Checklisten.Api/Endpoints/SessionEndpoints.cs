using System.Text.Json;
using Checklisten.Api.Auth;
using Checklisten.Api.Data;
using Checklisten.Api.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Endpoints;

public static class SessionEndpoints
{
    public sealed record AttachmentDto(Guid Id, string ItemId, string FileName, string Url, long FileSize, DateTime CreatedAt);
    public sealed record SessionDto(
        string Id, string TemplateId, JsonElement TemplateSnapshot,
        Guid CreatedBy, JsonElement Meta, JsonElement Values, JsonElement Skipped,
        DateTime CreatedAt, DateTime UpdatedAt, DateTime? ClosedAt,
        IReadOnlyList<AttachmentDto> Attachments);

    public sealed record SessionCreateDto(string TemplateId);
    public sealed record SessionPatchDto(JsonElement? Meta, JsonElement? Values, JsonElement? Skipped, bool? Closed);

    public static IEndpointRouteBuilder MapSessionEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/sessions").RequireAuthorization("AnyAuthenticated");

        // List sessions visible to the user (own only, admin sees all)
        grp.MapGet("/", async (AppDbContext db, HttpContext http) =>
        {
            var uid = http.User.UserId() ?? throw new UnauthorizedAccessException();
            var isAdmin = http.User.IsAdmin();
            var q = db.Sessions.AsQueryable();
            if (!isAdmin) q = q.Where(s => s.CreatedBy == uid);

            var sessions = await q.OrderByDescending(s => s.UpdatedAt).ToListAsync();
            var sessionIds = sessions.Select(s => s.Id).ToList();
            var atts = await db.Attachments.Where(a => sessionIds.Contains(a.SessionId)).ToListAsync();
            var grouped = atts.GroupBy(a => a.SessionId).ToDictionary(g => g.Key, g => g.ToList());

            var result = sessions.Select(s => ToDto(s, grouped.TryGetValue(s.Id, out var ax) ? ax : new List<Attachment>()));
            return Results.Ok(result);
        });

        grp.MapGet("/{id}", async (string id, AppDbContext db, HttpContext http) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanSee(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var atts = await db.Attachments.Where(a => a.SessionId == id).ToListAsync();
            return Results.Ok(ToDto(s, atts));
        });

        grp.MapPost("/", async ([FromBody] SessionCreateDto dto, AppDbContext db, HttpContext http) =>
        {
            var uid = http.User.UserId() ?? throw new UnauthorizedAccessException();
            var tpl = await db.Templates.FindAsync(dto.TemplateId);
            if (tpl is null || tpl.DeletedAt != null) return Results.NotFound(new { error = "template_not_found" });

            var id = "sess_" + Guid.NewGuid().ToString("N")[..16];
            // Initialise empty meta with the template's meta field names
            var metaObj = new Dictionary<string, string>();
            foreach (var f in tpl.Meta.RootElement.EnumerateArray())
                if (f.TryGetProperty("name", out var n)) metaObj[n.GetString() ?? ""] = "";

            var s = new Session
            {
                Id = id,
                TemplateId = tpl.Id,
                TemplateSnapshot = JsonDocument.Parse(JsonSerializer.Serialize(new {
                    id = tpl.Id, title = tpl.Title, subtitle = tpl.Subtitle, tag = tpl.Tag,
                    meta = tpl.Meta.RootElement, sections = tpl.Sections.RootElement,
                })),
                CreatedBy = uid,
                Meta = JsonDocument.Parse(JsonSerializer.Serialize(metaObj)),
                Values = JsonDocument.Parse("{}"),
            };
            db.Sessions.Add(s);
            await db.SaveChangesAsync();
            return Results.Ok(ToDto(s, new List<Attachment>()));
        });

        grp.MapPatch("/{id}", async (string id, [FromBody] SessionPatchDto dto, AppDbContext db, HttpContext http) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanEdit(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);

            if (dto.Meta is { } m && m.ValueKind != JsonValueKind.Undefined)
                s.Meta = JsonDocument.Parse(m.GetRawText());
            if (dto.Values is { } v && v.ValueKind != JsonValueKind.Undefined)
                s.Values = JsonDocument.Parse(v.GetRawText());
            if (dto.Skipped is { } sk && sk.ValueKind != JsonValueKind.Undefined)
                s.Skipped = JsonDocument.Parse(sk.GetRawText());
            if (dto.Closed is { } c)
                s.ClosedAt = c ? (s.ClosedAt ?? DateTime.UtcNow) : null;
            s.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            var atts = await db.Attachments.Where(a => a.SessionId == id).ToListAsync();
            return Results.Ok(ToDto(s, atts));
        });

        grp.MapDelete("/{id}", async (string id, AppDbContext db, HttpContext http) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanEdit(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            db.Sessions.Remove(s);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        // ---- Attachments ----
        grp.MapPost("/{id}/attachments", async (string id, IFormFile file, [FromForm] string itemId,
            AppDbContext db, HttpContext http, IConfiguration cfg, IWebHostEnvironment env) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanEdit(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            if (file is null || file.Length == 0) return Results.BadRequest(new { error = "no_file" });
            if (file.Length > 10 * 1024 * 1024) return Results.BadRequest(new { error = "file_too_large" });
            if (!file.ContentType.StartsWith("image/")) return Results.BadRequest(new { error = "not_an_image" });

            var baseRel = cfg["Attachments:Path"] ?? "../../data/attachments";
            var baseAbs = Path.GetFullPath(Path.Combine(env.ContentRootPath, baseRel));
            Directory.CreateDirectory(Path.Combine(baseAbs, id));

            var attId = Guid.NewGuid();
            var safeName = string.Join("_", file.FileName.Split(Path.GetInvalidFileNameChars()));
            var storagePath = Path.Combine(id, $"{attId:N}_{safeName}");
            var absPath = Path.Combine(baseAbs, storagePath);
            await using (var fs = File.Create(absPath)) await file.CopyToAsync(fs);

            var att = new Attachment
            {
                Id = attId, SessionId = id, ItemId = itemId,
                FileName = file.FileName, StoragePath = storagePath,
                FileSize = file.Length, ContentType = file.ContentType,
                CreatedBy = http.User.UserId() ?? Guid.Empty,
            };
            db.Attachments.Add(att);
            s.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();

            return Results.Ok(new AttachmentDto(att.Id, att.ItemId, att.FileName,
                $"/api/sessions/{id}/attachments/{att.Id}/file", att.FileSize, att.CreatedAt));
        }).DisableAntiforgery();

        grp.MapGet("/{id}/attachments/{attId:guid}/file", async (string id, Guid attId, AppDbContext db, HttpContext http,
            IConfiguration cfg, IWebHostEnvironment env) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanSee(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var att = await db.Attachments.FindAsync(attId);
            if (att is null || att.SessionId != id) return Results.NotFound();
            var baseAbs = Path.GetFullPath(Path.Combine(env.ContentRootPath, cfg["Attachments:Path"] ?? "../../data/attachments"));
            var abs = Path.Combine(baseAbs, att.StoragePath);
            if (!File.Exists(abs)) return Results.NotFound();
            return Results.File(abs, att.ContentType, att.FileName);
        });

        grp.MapDelete("/{id}/attachments/{attId:guid}", async (string id, Guid attId, AppDbContext db, HttpContext http,
            IConfiguration cfg, IWebHostEnvironment env) =>
        {
            var s = await db.Sessions.FindAsync(id);
            if (s is null) return Results.NotFound();
            if (!CanEdit(http, s)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var att = await db.Attachments.FindAsync(attId);
            if (att is null || att.SessionId != id) return Results.NotFound();
            var baseAbs = Path.GetFullPath(Path.Combine(env.ContentRootPath, cfg["Attachments:Path"] ?? "../../data/attachments"));
            var abs = Path.Combine(baseAbs, att.StoragePath);
            try { if (File.Exists(abs)) File.Delete(abs); } catch { /* leave orphan, will be cleaned by maintenance */ }
            db.Attachments.Remove(att);
            s.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        return app;
    }

    private static bool CanSee(HttpContext http, Session s) =>
        http.User.IsAdmin() || http.User.UserId() == s.CreatedBy;

    private static bool CanEdit(HttpContext http, Session s) =>
        http.User.IsAdmin() || http.User.UserId() == s.CreatedBy;

    private static SessionDto ToDto(Session s, IList<Attachment> atts) => new(
        s.Id, s.TemplateId, s.TemplateSnapshot.RootElement, s.CreatedBy,
        s.Meta.RootElement, s.Values.RootElement, s.Skipped.RootElement,
        s.CreatedAt, s.UpdatedAt, s.ClosedAt,
        atts.Select(a => new AttachmentDto(a.Id, a.ItemId, a.FileName,
            $"/api/sessions/{s.Id}/attachments/{a.Id}/file", a.FileSize, a.CreatedAt)).ToList());
}
