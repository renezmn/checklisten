using Checklisten.Api.Auth;
using Checklisten.Api.Data;
using Checklisten.Api.Models;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Endpoints;

public static class AuthEndpoints
{
    public sealed record LoginRequest(string Username, string Password);
    public sealed record UserDto(Guid Id, string Username, string DisplayName, string Role);

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var grp = app.MapGroup("/api/auth");

        grp.MapPost("/login", async ([FromBody] LoginRequest req, AppDbContext db, HttpContext http) =>
        {
            if (string.IsNullOrWhiteSpace(req.Username) || string.IsNullOrEmpty(req.Password))
                return Results.BadRequest(new { error = "username_password_required" });

            var user = await db.Users.SingleOrDefaultAsync(u => u.Username == req.Username.Trim());
            if (user is null || user.Disabled || !BCrypt.Net.BCrypt.Verify(req.Password, user.PasswordHash))
            {
                // small uniform delay to defang user-enumeration via timing
                await Task.Delay(150);
                return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            }

            await http.SignInAsync(AuthExtensions.Scheme, user.ToPrincipal(),
                new AuthenticationProperties { IsPersistent = true, ExpiresUtc = DateTimeOffset.UtcNow.AddDays(30) });

            return Results.Ok(new UserDto(user.Id, user.Username, user.DisplayName, user.Role.ToString()));
        });

        grp.MapPost("/logout", async (HttpContext http) =>
        {
            await http.SignOutAsync(AuthExtensions.Scheme);
            return Results.NoContent();
        }).RequireAuthorization("AnyAuthenticated");

        grp.MapGet("/me", async (HttpContext http, AppDbContext db) =>
        {
            var id = http.User.UserId();
            if (id is null) return Results.Json(new { error = "not_authenticated" }, statusCode: 401);
            var user = await db.Users.FindAsync(id.Value);
            if (user is null || user.Disabled)
            {
                await http.SignOutAsync(AuthExtensions.Scheme);
                return Results.Json(new { error = "not_authenticated" }, statusCode: 401);
            }
            return Results.Ok(new UserDto(user.Id, user.Username, user.DisplayName, user.Role.ToString()));
        }).RequireAuthorization("AnyAuthenticated");

        return app;
    }
}
