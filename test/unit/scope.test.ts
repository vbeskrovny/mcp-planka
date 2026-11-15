import { describe, expect, it } from "vitest";
import { ownPrivateScope } from "../../src/scope.js";

describe("ownPrivateScope", () => {
  const resp = {
    items: [
      { id: "1", ownerProjectManagerId: "pm1" },
      { id: "2", ownerProjectManagerId: null },
      { id: "3", ownerProjectManagerId: "pm3" },
      { id: "4", ownerProjectManagerId: "pm-unknown" },
    ],
    included: {
      projectManagers: [{ id: "pm1", userId: "me" }, { id: "pm3", userId: "someone" }],
      boards: [{ id: "b1", projectId: "1" }, { id: "b2", projectId: "2" }, { id: "b3", projectId: "3" }, { id: "b1x", projectId: "1" }],
    },
  };

  it("keeps only private projects owned by the API-key user", () => {
    const s = ownPrivateScope(resp, "me");
    expect([...s.projectIds]).toEqual(["1"]);
    expect(s.boards).toEqual([{ id: "b1", projectId: "1" }, { id: "b1x", projectId: "1" }]);
    expect(s.excludedProjects).toBe(3);
    expect(s.boardProject.get("b3")).toBe("3");
  });

  it("handles an empty or partial response", () => {
    expect(ownPrivateScope({}, "me")).toMatchObject({ boards: [], excludedProjects: 0 });
    expect(ownPrivateScope({ items: [{ id: "1", ownerProjectManagerId: "pm1" }] }, "me").projectIds.size).toBe(0);
  });
});
