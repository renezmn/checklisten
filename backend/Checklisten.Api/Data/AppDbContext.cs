using Checklisten.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Checklisten.Api.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User>        Users        => Set<User>();
    public DbSet<Template>    Templates    => Set<Template>();
    public DbSet<Session>     Sessions     => Set<Session>();
    public DbSet<Attachment>  Attachments  => Set<Attachment>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.ToTable("users");
            e.HasKey(u => u.Id);
            e.HasIndex(u => u.Username).IsUnique();
            e.Property(u => u.Username).HasMaxLength(64).IsRequired();
            e.Property(u => u.DisplayName).HasMaxLength(128);
            e.Property(u => u.PasswordHash).IsRequired();
            e.Property(u => u.Role).HasConversion<string>().HasMaxLength(16);
        });

        b.Entity<Template>(e =>
        {
            e.ToTable("templates");
            e.HasKey(t => t.Id);
            e.Property(t => t.Id).HasMaxLength(64);
            e.Property(t => t.Title).HasMaxLength(256).IsRequired();
            e.Property(t => t.Subtitle).HasMaxLength(512);
            e.Property(t => t.Tag).HasMaxLength(64);
            e.Property(t => t.Meta).HasColumnType("jsonb");
            e.Property(t => t.Sections).HasColumnType("jsonb");
            e.HasIndex(t => t.DeletedAt);
        });

        b.Entity<Session>(e =>
        {
            e.ToTable("sessions");
            e.HasKey(s => s.Id);
            e.Property(s => s.Id).HasMaxLength(64);
            e.Property(s => s.TemplateId).HasMaxLength(64).IsRequired();
            e.Property(s => s.TemplateSnapshot).HasColumnType("jsonb");
            e.Property(s => s.Meta).HasColumnType("jsonb");
            e.Property(s => s.Values).HasColumnType("jsonb");
            e.Property(s => s.Skipped).HasColumnType("jsonb");
            e.HasIndex(s => s.CreatedBy);
            e.HasIndex(s => s.UpdatedAt);
        });

        b.Entity<Attachment>(e =>
        {
            e.ToTable("attachments");
            e.HasKey(a => a.Id);
            e.Property(a => a.SessionId).HasMaxLength(64).IsRequired();
            e.Property(a => a.ItemId).HasMaxLength(128).IsRequired();
            e.Property(a => a.FileName).HasMaxLength(256);
            e.Property(a => a.StoragePath).HasMaxLength(1024).IsRequired();
            e.Property(a => a.ContentType).HasMaxLength(64);
            e.HasIndex(a => new { a.SessionId, a.ItemId });
            e.HasOne<Session>().WithMany().HasForeignKey(a => a.SessionId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
