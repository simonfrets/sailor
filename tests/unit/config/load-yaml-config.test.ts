import { z } from "zod";

import { loadYamlConfig } from "../../../src/config/load-yaml-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";

const schema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

const load = (text: string): z.output<typeof schema> =>
  loadYamlConfig(text, schema, { source: "config/example.yaml" });

describe("loadYamlConfig", () => {
  it("parses a valid document and applies schema defaults", () => {
    expect(load("version: 1\nname: example\n")).toEqual({
      version: 1,
      name: "example",
      tags: [],
    });
  });

  it("accepts a document written with CRLF line endings", () => {
    expect(load("version: 1\r\nname: example\r\n").name).toBe("example");
  });

  it("accepts a document that starts with a byte order mark", () => {
    expect(load("﻿version: 1\nname: example\n").name).toBe("example");
  });

  it("reports a syntax error with its line and column", () => {
    const error = captureError(
      () => load("version: 1\n  name: [unterminated\n"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("is not valid YAML");
    expect(error.details.join("\n")).toMatch(/config\/example\.yaml:\d+:\d+:/);
  });

  it("locates a schema failure at the offending node", () => {
    const error = captureError(
      () => load("version: 1\nname: example\ntags: notalist\n"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details).toHaveLength(1);
    expect(error.details[0]).toContain("config/example.yaml:3:7");
    expect(error.details[0]).toContain("(at tags)");
  });

  it("falls back to the enclosing node when a required field is absent", () => {
    // `version` has no node of its own, so the location walks out to the
    // mapping that should have contained it rather than reporting nothing.
    const error = captureError(() => load("name: example\n"), SailorError);

    expect(error.details[0]).toContain("config/example.yaml:1:1");
    expect(error.details[0]).toContain("(at version)");
  });

  it("reports every issue in one pass", () => {
    const error = captureError(
      () => load("version: 2\nname: ''\n"),
      SailorError
    );

    expect(error.details).toHaveLength(2);
  });

  it("names only the file when the document has no node to point at", () => {
    const error = captureError(() => load(""), SailorError);

    expect(error.details[0]).toContain("config/example.yaml:");
    expect(error.details[0]).not.toMatch(/\(at /);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const error = captureError(
      () => load("version: 1\nname: example\nunexpected: true\n"),
      SailorError
    );

    expect(error.details.join("\n")).toContain("unexpected");
  });
});
