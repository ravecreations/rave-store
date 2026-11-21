import { describe, expect, it } from "vitest";
import { csvText } from "./csv";

describe("csvText", () => {
  it.each(["+123", "  @reference", "＝value", "\ttracking"])(
    "marks spreadsheet-sensitive text as literal",
    (text) => {
      expect(csvText(text)).toBe(`'${text}`);
    },
  );

  it("preserves ordinary text and escapes field separators", () => {
    expect(csvText("buyer@example.com")).toBe("buyer@example.com");
    expect(csvText('Name, "quoted"')).toBe('"Name, ""quoted"""');
  });
});
