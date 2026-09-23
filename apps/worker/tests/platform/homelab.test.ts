import { describe, expect, it } from "vitest";
import { pickCaptcha } from "../../src/homelab";

describe("pickCaptcha", () => {
  it("strips spaces and maps digit lookalikes", () => {
    expect(pickCaptcha(["4 82 91 3"], true, 6)).toBe("482913");
    expect(pickCaptcha(["5O7 S6B"], true, 6)).toBe("507568");
  });
  it("prefers the first candidate with the expected length", () => {
    expect(pickCaptcha(["12345", "123456"], true, 6)).toBe("123456");
    expect(pickCaptcha(["Ayk Q2", "A7kQ2x"], false, 6)).toBe("A7kQ2x");
  });
});
