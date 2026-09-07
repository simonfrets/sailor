import { cleanEnvironment } from "../../helpers/git.js";

afterEach(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_INDEX_FILE;
});

describe("cleanEnvironment", () => {
  it("drops every variable git exports to a hook", () => {
    // This repository's own pre-commit hook runs the suite, so these are set
    // for real while the tests that spawn git are running.
    process.env.GIT_DIR = "/elsewhere/.git";
    process.env.GIT_INDEX_FILE = "/elsewhere/.git/index";

    const environment = cleanEnvironment();

    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_INDEX_FILE).toBeUndefined();
  });

  it("keeps the variables a spawned command still needs", () => {
    expect(cleanEnvironment().PATH).toBe(process.env.PATH);
  });

  it("applies overrides on top", () => {
    expect(cleanEnvironment({ SAILOR_FAKE_EXIT: "4" }).SAILOR_FAKE_EXIT).toBe(
      "4"
    );
  });
});
