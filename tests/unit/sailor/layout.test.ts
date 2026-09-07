import { join } from "node:path";

import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../../../src/sailor/layout.js";

describe("sailor layout", () => {
  it("reserves .sailor as the installation directory", () => {
    expect(SAILOR_DIRECTORY).toBe(".sailor");
  });

  it("keeps every managed path relative to the sailor directory", () => {
    expect(Object.values(SAILOR_PATHS).length).toBeGreaterThan(0);

    for (const path of Object.values(SAILOR_PATHS)) {
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith(".sailor")).toBe(false);
    }
  });

  it("joins segments beneath the sailor directory of a project", () => {
    expect(sailorPath("/tmp/project", SAILOR_PATHS.rules, "base.yaml")).toBe(
      join("/tmp/project", ".sailor", "rules", "base.yaml")
    );
  });

  it("resolves the sailor directory itself when given no segments", () => {
    expect(sailorPath("/tmp/project")).toBe(join("/tmp/project", ".sailor"));
  });
});
