using System.Text.Json;

namespace Checklisten.Api.Models;

public sealed class Template
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Subtitle { get; set; }
    public string? Tag { get; set; }
    public JsonDocument Meta { get; set; } = JsonDocument.Parse("[]");
    public JsonDocument Sections { get; set; } = JsonDocument.Parse("[]");
    public Guid? OwnerId { get; set; }
    public bool IsSystem { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DeletedAt { get; set; }
}
