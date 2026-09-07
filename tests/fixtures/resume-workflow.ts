/**
 * Resumes a stopped workflow in a process of its own.
 *
 * This is the second half of acceptance criterion 9. It is a separate file
 * rather than a block inside a test because the criterion is about a process
 * boundary: this program is started fresh, shares no memory with whatever
 * stopped, and is given nothing but two paths. Everything it knows about the
 * task it reads out of `.sailor/tasks.yaml`.
 *
 * The summary goes to stdout as JSON, which is the only channel back.
 */
import { driveWorkflow } from "../helpers/workflow-driver.js";

const [packageRoot, projectRoot] = process.argv.slice(2);

if (packageRoot === undefined || projectRoot === undefined) {
  throw new Error("usage: resume-workflow.ts <package-root> <project-root>");
}

const summary = await driveWorkflow({ packageRoot, projectRoot });

process.stdout.write(`${JSON.stringify(summary)}\n`);
