import { describe, expect, it } from "vitest";
import {
  escapeDiscordMarkup,
  normalizeDisplayName,
  renderDisplayLabel,
} from "../src/ingest/sanitize";

describe("stored display names", () => {
  it("preserves visible syntax, emoji, and CJK and normalizes NFC", () => {
    expect(normalizeDisplayName("  @#<>[]()`*_~|\\ 😀 雪 e\u0301  ")).toBe(
      "@#<>[]()`*_~|\\ 😀 雪 é",
    );
  });
  it("removes controls and formats, then collapses Unicode whitespace", () => {
    expect(
      normalizeDisplayName("A\u0000\u0085\u200b\u200c\u200d\u202e\u2066\ufeff B\u3000\u00a0C"),
    ).toBe("A B C");
    expect(normalizeDisplayName("\u200b\u0000\u202e")).toBeNull();
    expect(normalizeDisplayName(" \u3000 ")).toBeNull();
  });
  it("truncates at 64 Unicode code points without splitting astral characters", () => {
    const name = normalizeDisplayName("😀".repeat(65));
    expect(name).toBe("😀".repeat(64));
    expect(Array.from(name!)).toHaveLength(64);
    expect(name!.isWellFormed()).toBe(true);
  });
});

describe("immutable display labels", () => {
  it("escapes every markdown control and mention token without deleting visible characters", () => {
    expect(escapeDiscordMarkup("\\`*_~|[] @everyone @here <@12> <#34> 雪😀")).toBe(
      "\\\\\\`\\*\\_\\~\\|\\[\\] \\@everyone \\@here \\<\\@12> \\<#34> 雪😀",
    );
    expect(escapeDiscordMarkup(">quote")).toBe("\\>quote");
    expect(escapeDiscordMarkup("#heading")).toBe("\\#heading");
    expect(escapeDiscordMarkup("A > B #tag")).toBe("A > B #tag");
  });
  it("renders a complete masked link as literal visible text", () => {
    const name = "[Frost](https://example.com)";
    expect(normalizeDisplayName(name)).toBe(name);
    expect(renderDisplayLabel(name, "12345")).toBe("\\[Frost\\](https://example.com)");
  });
  it("caps escaped text at 80 code points with complete escape pairs", () => {
    const label = renderDisplayLabel("😀".repeat(79) + "@", "12345");
    expect(label).toBe("😀".repeat(79));
    expect(label.isWellFormed()).toBe(true);
    expect(renderDisplayLabel("\\".repeat(64), "12345")).toBe("\\".repeat(80));
    expect(renderDisplayLabel("@".repeat(64), "12345")).toBe("\\@".repeat(40));
    expect(renderDisplayLabel("a".repeat(78) + "[", "12345")).toBe("a".repeat(78) + "\\[");
    expect(renderDisplayLabel("a".repeat(79) + "[", "12345")).toBe("a".repeat(79));
    expect(renderDisplayLabel("a".repeat(78) + "]", "12345")).toBe("a".repeat(78) + "\\]");
    expect(renderDisplayLabel("a".repeat(79) + "]", "12345")).toBe("a".repeat(79));
  });
  it("uses the ID fallback for absent or empty names", () => {
    expect(renderDisplayLabel(null, "0000123")).toBe("ID 0000123");
    expect(renderDisplayLabel("", "12345")).toBe("ID 12345");
  });
});
