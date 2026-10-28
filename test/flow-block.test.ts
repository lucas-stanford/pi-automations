import { describe, expect, it } from "vitest";

import { findFlowBlock, setFlowBlock } from "../src/flow-block.js";

describe("flow blocks in AUTOMATION.md", () => {
  it("skips frontmatter and finds the first flowchart block only", () => {
    const md = [
      "---",
      "name: daily",
      "---",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
      "```mermaid",
      "%% comment",
      "",
      "flowchart TD",
      "  body[Body]",
      "```",
      "```mermaid",
      "graph LR",
      "  a --> b",
      "```",
      "",
    ].join("\n");
    expect(findFlowBlock(md)?.text).toBe("%% comment\n\nflowchart TD\n  body[Body]\n");
  });

  it("accepts tildes, graph LR and indented fences whose content is de-indented", () => {
    const md = "Intro\n  ~~~mermaid\n  graph LR\n    a --> b\n  ~~~\n";
    const block = findFlowBlock(md);
    expect(block?.text).toBe("graph LR\n  a --> b\n");
    expect(md.slice(block!.start, block!.end)).toBe("  ~~~mermaid\n  graph LR\n    a --> b\n  ~~~\n");
  });

  it("does not treat an inner mermaid example in a longer markdown fence as a chart", () => {
    const md = "````markdown\n```mermaid\nflowchart TD\n  a\n```\n````\n```mermaid\ngraph LR\n  b\n```\n";
    expect(findFlowBlock(md)?.text).toBe("graph LR\n  b\n");
  });

  it("skips unclosed fences and non-flowchart mermaid diagrams", () => {
    expect(findFlowBlock("```mermaid\nflowchart TD\n  a\n")).toBeNull();
    expect(findFlowBlock("```mermaid\nsequenceDiagram\n  A->>B: hi\n```\ntext\n")).toBeNull();
  });

  it("reports offsets against the original CRLF document and normalizes text to LF", () => {
    const md = "Title\r\n\r\n```mermaid\r\nflowchart TD\r\n  body[Body]\r\n```\r\nTail\r\n";
    const block = findFlowBlock(md)!;
    expect(block.start).toBe(md.indexOf("```mermaid"));
    expect(block.end).toBe(md.indexOf("Tail"));
    expect(block.text).toBe("flowchart TD\n  body[Body]\n");
  });

  it("inserts after an ATX heading or at the body start without one", () => {
    expect(setFlowBlock("# Title\n\nBody\n", "flowchart TD\n  body\n")).toBe("# Title\n\n```mermaid\nflowchart TD\n  body\n```\n\nBody\n");
    expect(setFlowBlock("Body\n", "graph LR\n  a --> b\n")).toBe("```mermaid\ngraph LR\n  a --> b\n```\n\nBody\n");
    expect(setFlowBlock("---\nname: x\n---\n\nBody\n", "flowchart TD\n  body\n")).toBe("---\nname: x\n---\n\n```mermaid\nflowchart TD\n  body\n```\n\nBody\n");
  });

  it("replaces content byte-for-byte around the block, preserving CRLF and lengthening fences", () => {
    const md = "A\r\n```mermaid info\r\nflowchart TD\r\n  a\r\n```\r\nB\r\n";
    const out = setFlowBlock(md, "flowchart TD\n  ``` tricky\n  b\n");
    expect(out.startsWith("A\r\n````mermaid info\r\n")).toBe(true);
    expect(out.endsWith("````\r\nB\r\n")).toBe(true);
    expect(out).toContain("flowchart TD\r\n  ``` tricky\r\n  b\r\n");
  });

  it("removes a block without leaving a double blank line and no-ops when absent", () => {
    const md = "A\n\n```mermaid\nflowchart TD\n  a\n```\n\nB\n";
    expect(setFlowBlock(md, null)).toBe("A\n\nB\n");
    expect(setFlowBlock("A\nB\n", null)).toBe("A\nB\n");
  });

  it("uses a longer inserted fence when the chart contains backticks", () => {
    const chart = "flowchart TD\n  ``` tricky\n";
    const out = setFlowBlock("# T\n", chart);
    expect(out).toContain("````mermaid\n");
    expect(findFlowBlock(out)?.text).toBe(chart);
  });
});
