using System.Security.Claims;
using Checklisten.Api.Models;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace Checklisten.Api.Auth;

public static class AuthExtensions
{
    public const string Scheme = CookieAuthenticationDefaults.AuthenticationScheme;

    public static IServiceCollection AddChecklistenAuth(this IServiceCollection services)
    {
        services
            .AddAuthentication(Scheme)
            .AddCookie(o =>
            {
                o.Cookie.Name = "checklisten.sid";
                o.Cookie.HttpOnly = true;
                o.Cookie.SameSite = SameSiteMode.Lax;
                o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
                o.ExpireTimeSpan = TimeSpan.FromDays(30);
                o.SlidingExpiration = true;
                // Return JSON 401/403 instead of redirecting to /Account/Login
                o.Events.OnRedirectToLogin = ctx =>
                {
                    ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                };
                o.Events.OnRedirectToAccessDenied = ctx =>
                {
                    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return Task.CompletedTask;
                };
            });

        services.AddAuthorizationBuilder()
            .AddPolicy("Admin",            p => p.RequireRole(nameof(UserRole.Admin)))
            .AddPolicy("EditorOrAdmin",    p => p.RequireRole(nameof(UserRole.Editor), nameof(UserRole.Admin)))
            .AddPolicy("AnyAuthenticated", p => p.RequireAuthenticatedUser());

        return services;
    }

    public static ClaimsPrincipal ToPrincipal(this User user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Name,           user.Username),
            new(ClaimTypes.GivenName,      user.DisplayName ?? user.Username),
            new(ClaimTypes.Role,           user.Role.ToString()),
        };
        var identity = new ClaimsIdentity(claims, Scheme);
        return new ClaimsPrincipal(identity);
    }

    public static Guid? UserId(this ClaimsPrincipal user) =>
        Guid.TryParse(user.FindFirstValue(ClaimTypes.NameIdentifier), out var g) ? g : null;

    public static UserRole? Role(this ClaimsPrincipal user) =>
        Enum.TryParse<UserRole>(user.FindFirstValue(ClaimTypes.Role), out var r) ? r : null;

    public static bool IsAdmin(this ClaimsPrincipal user) => user.Role() == UserRole.Admin;

    public static bool CanEditTemplates(this ClaimsPrincipal user) =>
        user.Role() is UserRole.Editor or UserRole.Admin;
}
