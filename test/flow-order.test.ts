import { describe, expect, it } from "vitest";
import { flowOrder, parseChart } from "../src/chart.js";
import { foldEvents } from "../src/progress.js";

const order = (text: string) => flowOrder(parseChart(text)).map((n) => n.id);

// my-team-review's chart: a saved review goes straight from the body to post.
const TEAM_REVIEW = `flowchart TD
  pre0["Pick a teammate's PR"] --> body["Review the PR"]
  body --> read["Read the change"]
  body -->|saved review or sign-off| post["Post the review"]
  read --> map["Map the change"]
  map --> panel["The reviewers"]
  panel --> draft["Choose the findings"]
  draft --> post
  post --> post0["Record the run"]`;

describe("flowOrder", () => {
  it("puts a step after every step with an arrow into it, not where a shortcut first names it", () => {
    expect(order(TEAM_REVIEW)).toEqual(["pre0", "body", "read", "map", "panel", "draft", "post", "post0"]);
  });

  it("keeps chart order when the arrows allow it", () => {
    expect(order("flowchart TD\n  a --> b\n  b --> c\n  a --> d")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a loop's steps together and before what it leads to", () => {
    const text = "flowchart TD\n  start --> fix\n  fix --> test\n  test -->|fails| fix\n  start --> done\n  test -->|passes| done";
    expect(order(text)).toEqual(["start", "fix", "test", "done"]);
  });

  it("keeps nodes with no arrows where the chart puts them", () => {
    expect(order("flowchart TD\n  a[A]\n  b --> c\n  z[Z]")).toEqual(["a", "b", "c", "z"]);
  });

  it("orders a run's progress nodes the same way", () => {
    const snap = foldEvents([{ t: "open", run: "r", key: "k", name: "n", chart: TEAM_REVIEW, at: "2026-10-27T00:00:00Z" } as never]);
    expect(snap?.nodes.map((n) => n.id)).toEqual(["pre0", "body", "read", "map", "panel", "draft", "post", "post0"]);
  });
});
