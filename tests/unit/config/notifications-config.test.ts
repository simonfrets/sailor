import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FAILURE_POLICIES,
  loadNotificationsConfig,
  notificationsConfigSchema,
  readInstalledNotificationsConfig,
} from "../../../src/config/notifications-config.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

describe("notificationsConfigSchema", () => {
  it("names the channels and failure policies", () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(["log", "command"]);
    expect([...NOTIFICATION_FAILURE_POLICIES]).toEqual(["block", "record"]);
  });

  it("validates with nothing but a version, so an older seeded file keeps parsing", () => {
    expect(notificationsConfigSchema.parse({ version: 1 })).toEqual({
      version: 1,
      channel: "log",
      onFailure: "block",
      command: { argv: [], timeoutMs: 30_000 },
    });
  });

  it("requires a command before the command channel can be chosen", () => {
    expect(
      notificationsConfigSchema.safeParse({ version: 1, channel: "command" })
        .success
    ).toBe(false);
    expect(
      notificationsConfigSchema.safeParse({
        version: 1,
        channel: "command",
        command: { argv: ["notify-send", "task done"] },
      }).success
    ).toBe(true);
  });

  it("refuses a key it does not know and an unbounded timeout", () => {
    expect(
      notificationsConfigSchema.safeParse({ version: 1, chanel: "log" }).success
    ).toBe(false);
    expect(
      notificationsConfigSchema.safeParse({
        version: 1,
        command: { argv: ["x"], timeoutMs: 10 },
      }).success
    ).toBe(false);
  });
});

describe("readInstalledNotificationsConfig", () => {
  it("reads the installed file", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/config/notifications.yaml": [
          "version: 1",
          "channel: command",
          "onFailure: record",
          "command:",
          "  argv: [notify-send, done]",
          "",
        ].join("\n"),
      },
    });

    expect(readInstalledNotificationsConfig(root)).toEqual({
      version: 1,
      channel: "command",
      onFailure: "record",
      command: { argv: ["notify-send", "done"], timeoutMs: 30_000 },
    });
  });

  it("falls back to the defaults when the file was never installed", () => {
    // An installation made before this file shipped has no copy. Defaults
    // apply: completions are logged locally, and `doctor` says nobody is told.
    expect(readInstalledNotificationsConfig(buildSailorProject())).toEqual(
      notificationsConfigSchema.parse({ version: 1 })
    );
  });

  it("reports an invalid installed file rather than quietly using defaults", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/config/notifications.yaml":
          "version: 1\nchannel: carrier-pigeon\n",
      },
    });
    const error = captureError(
      () => readInstalledNotificationsConfig(root),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/config/notifications.yaml");
  });
});

describe("loadNotificationsConfig", () => {
  it("names the source in a validation error", () => {
    const error = captureError(
      () =>
        loadNotificationsConfig("version: 2\n", {
          source: "config/notifications.yaml",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("config/notifications.yaml");
  });
});
