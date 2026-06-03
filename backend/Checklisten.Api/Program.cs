using Checklisten.Api.Auth;
using Checklisten.Api.Data;
using Checklisten.Api.Endpoints;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

// ---- DI ----------------------------------------------------------------------
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Postgres")));

builder.Services.AddHttpClient();

builder.Services.AddChecklistenAuth();

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .SetIsOriginAllowed(_ => true)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// JSON: enums as strings
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

// ---- Build & Pipeline --------------------------------------------------------
var app = builder.Build();

app.UseForwardedHeaders(new ForwardedHeadersOptions {
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto });

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

// Static frontend (configurable path so dev can serve from ../../frontend)
var frontendCfg = builder.Configuration["Frontend:PathRelativeToContentRoot"] ?? "../../frontend";
var frontendPath = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, frontendCfg));
if (Directory.Exists(frontendPath))
{
    var provider = new PhysicalFileProvider(frontendPath);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = provider });
    app.UseStaticFiles(new StaticFileOptions {
        FileProvider = provider,
        OnPrepareResponse = ctx =>
        {
            // In Development we serve frontend files with no-cache so reloads pick up edits.
            if (app.Environment.IsDevelopment())
                ctx.Context.Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        }
    });
    app.Logger.LogInformation("Frontend wird aus {Path} ausgeliefert", frontendPath);
}
else
{
    app.Logger.LogWarning("Frontend-Verzeichnis {Path} nicht gefunden – nur API verfügbar", frontendPath);
}

// ---- Endpoints ---------------------------------------------------------------
app.MapAuthEndpoints();
app.MapTemplateEndpoints();
app.MapSessionEndpoints();
app.MapUserEndpoints();
app.MapUpdateEndpoints();
app.MapGet("/api/health", () => Results.Ok(new { ok = true, ts = DateTime.UtcNow }));

// ---- Seed & run --------------------------------------------------------------
await DbSeeder.SeedAsync(app.Services, app.Configuration, app.Environment, app.Logger);
app.Run();
