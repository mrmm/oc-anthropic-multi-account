import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  UI,
  success,
  error,
  warning,
  info,
  plain,
  header,
  kv,
  item,
  numbered,
  divider,
  Ansi,
  colorize,
  formatPercent,
} from "../src/ui-utils.js";

describe("ui-utils", () => {
  let captured: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    captured = [];
    console.log = (...args: any[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.error = (...args: any[]) => {
      captured.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  describe("constants", () => {
    it("has status indicators", () => {
      expect(UI.SUCCESS).toBe("[OK]");
      expect(UI.ERROR).toBe("[ERR]");
      expect(UI.WARNING).toBe("[WARN]");
      expect(UI.INFO).toBe("[INFO]");
    });

    it("has indent strings", () => {
      expect(UI.INDENT).toBe("  ");
      expect(UI.INDENT2).toBe("    ");
    });
  });

  describe("success/error/warning/info", () => {
    it("prints success message with green [OK] prefix", () => {
      success("Operation completed");
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("[OK]");
      expect(captured[0]).toContain("Operation completed");
      expect(captured[0]).toContain(Ansi.GREEN);
    });

    it("prints error message with red [ERR] prefix", () => {
      error("Something failed");
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("[ERR]");
      expect(captured[0]).toContain("Something failed");
      expect(captured[0]).toContain(Ansi.RED);
    });

    it("prints warning message with yellow [WARN] prefix", () => {
      warning("This is a warning");
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("[WARN]");
      expect(captured[0]).toContain("This is a warning");
      expect(captured[0]).toContain(Ansi.YELLOW);
    });

    it("prints info message with cyan [INFO] prefix", () => {
      info("Some information");
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("[INFO]");
      expect(captured[0]).toContain("Some information");
      expect(captured[0]).toContain(Ansi.CYAN);
    });

    it("respects indent parameter", () => {
      success("Indented", 4);
      expect(captured[0]).toMatch(/^    /); // Starts with 4 spaces
    });
  });

  describe("plain", () => {
    it("prints message without prefix", () => {
      plain("Just text");
      expect(captured.length).toBe(1);
      expect(captured[0]).toBe("Just text");
      expect(captured[0]).not.toContain("[OK]");
    });

    it("respects indent parameter", () => {
      plain("Indented", 6);
      expect(captured[0]).toBe("      Indented");
    });
  });

  describe("header", () => {
    it("prints title with divider", () => {
      header("Test Header");
      expect(captured.length).toBe(4);
      expect(captured[0]).toBe("");
      expect(captured[1]).toBe("  Test Header");
      expect(captured[2]).toBe(`  ${UI.DIVIDER}`);
      expect(captured[3]).toBe("");
    });
  });

  describe("kv", () => {
    it("prints key-value pair with padding", () => {
      kv("Name", "John");
      expect(captured[0]).toBe("  Name               John");
    });

    it("pads key to 18 characters", () => {
      kv("Short", "value");
      expect(captured[0]).toMatch(/^  Short              value$/);
    });

    it("handles numeric values", () => {
      kv("Count", 42);
      expect(captured[0]).toBe("  Count              42");
    });
  });

  describe("item", () => {
    it("prints bullet list item", () => {
      item("First item");
      expect(captured[0]).toBe("  - First item");
    });

    it("respects indent parameter", () => {
      item("Indent", 4);
      expect(captured[0]).toBe("    - Indent");
    });
  });

  describe("numbered", () => {
    it("prints numbered item", () => {
      numbered(1, "First step");
      expect(captured[0]).toBe("  1. First step");
    });

    it("respects indent parameter", () => {
      numbered(2, "Second", 4);
      expect(captured[0]).toBe("    2. Second");
    });
  });

  describe("divider", () => {
    it("prints divider line", () => {
      divider();
      expect(captured[0]).toBe(UI.DIVIDER);
    });

    it("respects indent parameter", () => {
      divider(4);
      expect(captured[0]).toBe(`    ${UI.DIVIDER}`);
    });
  });

  describe("colorize", () => {
    it("wraps text in color codes", () => {
      const result = colorize("test", "RED");
      expect(result).toBe(`${Ansi.RED}test${Ansi.RESET}`);
    });

    it("works with all color names", () => {
      expect(colorize("a", "GREEN")).toContain(Ansi.GREEN);
      expect(colorize("b", "YELLOW")).toContain(Ansi.YELLOW);
      expect(colorize("c", "CYAN")).toContain(Ansi.CYAN);
    });
  });

  describe("formatPercent", () => {
    it("returns percentage string", () => {
      expect(formatPercent(0.5)).toBe("50%");
    });

    it("colors high values red", () => {
      const result = formatPercent(0.9); // 90% > 80% threshold
      expect(result).toContain(Ansi.RED);
    });

    it("colors medium values yellow", () => {
      const result = formatPercent(0.75); // 75% > 70% threshold
      expect(result).toContain(Ansi.YELLOW);
    });

    it("low values are plain", () => {
      const result = formatPercent(0.5); // 50% < 70% threshold
      expect(result).not.toContain(Ansi.RED);
      expect(result).not.toContain(Ansi.YELLOW);
    });

    it("accepts custom threshold", () => {
      const result = formatPercent(0.6, 0.5); // 60% > 50% threshold
      expect(result).toContain(Ansi.RED);
    });
  });
});
