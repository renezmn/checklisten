using System.Text.Json;

namespace Checklisten.Api.Models;

public sealed class Session
{
    public string Id { get; set; } = string.Empty;
    public string TemplateId { get; set; } = string.Empty;
    public JsonDocument TemplateSnapshot { get; set; } = JsonDocument.Parse("{}");
    public Guid CreatedBy { get; set; }
    public JsonDocument Meta { get; set; } = JsonDocument.Parse("{}");
    public JsonDocument Values { get; set; } = JsonDocument.Parse("{}");
    /// <summary>
    /// Map of itemId -> skip-reason (string). If a key is present, the item counts as
    /// "skipped" (gilt als erledigt), regardless of values[id]. Empty/missing = not skipped.
    /// </summary>
    public JsonDocument Skipped { get; set; } = JsonDocument.Parse("{}");
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ClosedAt { get; set; }
}

public sealed class Attachment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string SessionId { get; set; } = string.Empty;
    public string ItemId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string StoragePath { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string ContentType { get; set; } = "image/jpeg";
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
