using Checklisten.Api.Data;
using Checklisten.Api.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Endpoints;

public static class UserEndpoints
{
    public sealed record UserDto(Guid Id, string Username, string DisplayName, string Role, bool Disabled, DateTime CreatedAt);
    public sealed record UserCreateDto(string Username, string DisplayName, string Password, UserRole Role);
    public sealed record UserUpdateDto(string? DisplayName, UserRole? Role, bool? Disabled, string? NewPassword);

    public static IEndpointRouteBuilder MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/users").RequireAuthorization("Admin");

        grp.MapGet("/", async (AppDbContext db) =>
        {
            var list = await db.Users
                .OrderBy(u => u.Username)
                .Select(u => new UserDto(u.Id, u.Username, u.DisplayName, u.Role.ToString(), u.Disabled, u.CreatedAt))
                .ToListAsync();
            return Results.Ok(list);
        });

        grp.MapPost("/", async ([FromBody] UserCreateDto dto, AppDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Username)) return Results.BadRequest(new { error = "username_required" });
            if (string.IsNullOrEmpty(dto.Password) || dto.Password.Length < 6) return Results.BadRequest(new { error = "password_min_6" });
            var uname = dto.Username.Trim();
            if (await db.Users.AnyAsync(u => u.Username == uname)) return Results.Conflict(new { error = "username_taken" });
            var u = new User
            {
                Username = uname,
                DisplayName = string.IsNullOrWhiteSpace(dto.DisplayName) ? uname : dto.DisplayName.Trim(),
                Role = dto.Role,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password),
            };
            db.Users.Add(u);
            await db.SaveChangesAsync();
            return Results.Ok(new UserDto(u.Id, u.Username, u.DisplayName, u.Role.ToString(), u.Disabled, u.CreatedAt));
        });

        grp.MapPatch("/{id:guid}", async (Guid id, [FromBody] UserUpdateDto dto, AppDbContext db) =>
        {
            var u = await db.Users.FindAsync(id);
            if (u is null) return Results.NotFound();
            if (dto.DisplayName is not null) u.DisplayName = dto.DisplayName.Trim();
            if (dto.Role is { } r) u.Role = r;
            if (dto.Disabled is { } d) u.Disabled = d;
            if (!string.IsNullOrEmpty(dto.NewPassword))
            {
                if (dto.NewPassword.Length < 6) return Results.BadRequest(new { error = "password_min_6" });
                u.PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.NewPassword);
            }
            u.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.Ok(new UserDto(u.Id, u.Username, u.DisplayName, u.Role.ToString(), u.Disabled, u.CreatedAt));
        });

        grp.MapDelete("/{id:guid}", async (Guid id, AppDbContext db, HttpContext http) =>
        {
            var u = await db.Users.FindAsync(id);
            if (u is null) return Results.NotFound();
            var meStr = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            if (meStr == id.ToString()) return Results.BadRequest(new { error = "cannot_delete_self" });
            if (u.Role == UserRole.Admin && await db.Users.CountAsync(x => x.Role == UserRole.Admin && !x.Disabled) <= 1)
                return Results.BadRequest(new { error = "cannot_delete_last_admin" });
            db.Users.Remove(u);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        return app;
    }
}
