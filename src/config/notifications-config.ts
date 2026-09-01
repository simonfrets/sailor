import { z } from "zod";

import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import {
  MAX_CHECK_TIMEOUT_MS,
  MIN_CHECK_TIMEOUT_MS,
} from "../rules/rule-schema.js";
import { loadYamlConfig } from "./load-yaml-config.js";

/**
 * Where a completion notification goes. `log` appends a JSON line under the
 * ignored `state/` tree, which records the fact on this machine and tells
 * nobody; `command` runs a program the project configured, which is how a
 * completion reaches a human. `doctor` warns while the channel is `log`.
 */
export const NOTIFICATION_CHANNELS = ["log", "command"] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/**
 * What a failed delivery does to the completion that triggered it. `block`
 * refuses the completion - being told is part of what criterion 10 demands -
 * and `record` lets it proceed with the failure written into the evidence.
 */
export const NOTIFICATION_FAILURE_POLICIES = ["block", "record"] as const;
export const notificationFailurePolicySchema = z.enum(
  NOTIFICATION_FAILURE_POLICIES
);

const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;

const commandShape = z.strictObject({
  /** An argument vector, never a shell string; empty means not configured. */
  argv: z.array(z.string().min(1)).default([]),
  timeoutMs: z
    .int()
    .min(MIN_CHECK_TIMEOUT_MS)
    .max(MAX_CHECK_TIMEOUT_MS)
    .default(DEFAULT_NOTIFY_TIMEOUT_MS),
});

/**
 * Every key has a default, deliberately: this is a seeded file, written once
 * and never reconciled, so a copy written by an older sailor must keep
 * parsing when a newer one adds a key. `version: 1` alone is a valid file.
 */
export const notificationsConfigSchema = z
  .strictObject({
    version: z.literal(1),
    channel: notificationChannelSchema.default("log"),
    onFailure: notificationFailurePolicySchema.default("block"),
    command: commandShape.default({
      argv: [],
      timeoutMs: DEFAULT_NOTIFY_TIMEOUT_MS,
    }),
  })
  .superRefine((config, ctx) => {
    if (config.channel === "command" && config.command.argv.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["command", "argv"],
        message:
          "the command channel needs a command: declare `command.argv` or use `channel: log`",
      });
    }
  });

export type NotificationChannel = z.output<typeof notificationChannelSchema>;
export type NotificationFailurePolicy = z.output<
  typeof notificationFailurePolicySchema
>;
export type NotificationsConfig = z.output<typeof notificationsConfigSchema>;

export const loadNotificationsConfig = (
  text: string,
  options: { readonly source: string }
): NotificationsConfig =>
  loadYamlConfig(text, notificationsConfigSchema, options);

/**
 * The installed copy, or the defaults where none was ever installed.
 *
 * A missing file is normal - installations made before this file shipped
 * have no copy, and the defaults are what they would have been seeded with.
 * An invalid file is not: a project that configured a channel and mistyped
 * it would otherwise have its completions quietly logged to a file nobody
 * reads, which is the opposite of what it asked for.
 */
export const readInstalledNotificationsConfig = (
  projectRoot: string
): NotificationsConfig => {
  const source = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.notificationsConfig}`;
  const text = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.notificationsConfig)
  );

  return text === null
    ? notificationsConfigSchema.parse({ version: 1 })
    : loadNotificationsConfig(text, { source });
};
