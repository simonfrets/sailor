import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  NotificationChannel,
  NotificationsConfig,
} from "../config/notifications-config.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import {
  commandSucceeded,
  describeCommand,
  describeCommandResult,
} from "../processes/command-runner.js";
import type { CommandRunner } from "../processes/command-runner.js";
import type { TaskState } from "../tasks/task-schema.js";

/** What a human is told about. One task, one state it reached, one instant. */
export interface TaskNotification {
  readonly taskId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly runId: string;
  readonly revision: number;
  readonly at: string;
}

/**
 * What happened to one notification. Never an exception: the result is
 * recorded either way, and whether a failure blocks the completion that
 * caused it is the caller's policy, not the channel's.
 */
export interface NotificationResult {
  readonly channel: NotificationChannel;
  readonly status: "delivered" | "failed";
  readonly detail: string;
  readonly at: string;
}

export type Notifier = (
  notification: TaskNotification
) => Promise<NotificationResult>;

/** The log's project-relative path, with `/` separators on every platform. */
export const NOTIFICATIONS_LOG_PATH = `${SAILOR_DIRECTORY}/state/notifications.jsonl`;

export interface CreateNotifierOptions {
  readonly projectRoot: string;
  readonly config: NotificationsConfig;
  readonly runner: CommandRunner;
  readonly now: () => Date;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds the notifier the configuration asks for.
 *
 * The `log` channel appends one JSON line per notification to the ignored
 * `state/` tree - the fact is recorded, machine-locally, and `doctor` warns
 * that nobody is told. The `command` channel runs the configured argument
 * vector through the injectable runner with the task in `SAILOR_TASK_*`
 * environment variables rather than on stdin, because the runner points a
 * child's stdin at `/dev/null` so commands that prompt fail fast.
 */
export const createNotifier =
  (options: CreateNotifierOptions): Notifier =>
  async (notification) => {
    const at = options.now().toISOString();

    if (options.config.channel === "command") {
      const [executable, ...args] = options.config.command.argv;

      if (executable === undefined) {
        // The schema refuses this pairing; stated rather than assumed so a
        // config built in code cannot silently notify nobody.
        return {
          channel: "command",
          status: "failed",
          detail: "the command channel has no command configured",
          at,
        };
      }

      const command = { executable, args };
      const result = await options.runner({
        command,
        cwd: options.projectRoot,
        env: {
          SAILOR_NOTIFIED_AT: notification.at,
          SAILOR_TASK_ID: notification.taskId,
          SAILOR_TASK_REVISION: String(notification.revision),
          SAILOR_TASK_RUN_ID: notification.runId,
          SAILOR_TASK_STATE: notification.state,
          SAILOR_TASK_TITLE: notification.title,
        },
        timeoutMs: options.config.command.timeoutMs,
      });
      const delivered = commandSucceeded(result);
      const stderr = result.output.stderr.trim();

      return {
        channel: "command",
        status: delivered ? "delivered" : "failed",
        detail: `\`${describeCommand(command)}\` ${describeCommandResult(result)}${
          delivered || stderr === "" ? "" : `\n${stderr}`
        }`,
        at,
      };
    }

    try {
      const path = sailorPath(
        options.projectRoot,
        SAILOR_PATHS.notificationsLog
      );

      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(notification)}\n`);

      return {
        channel: "log",
        status: "delivered",
        detail: `appended to ${NOTIFICATIONS_LOG_PATH}`,
        at,
      };
    } catch (error: unknown) {
      return {
        channel: "log",
        status: "failed",
        detail: describeError(error),
        at,
      };
    }
  };
