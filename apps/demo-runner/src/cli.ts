import { runDemo } from "./index.js";
import type { RunEvent } from "@reprosmith/core";

const summary = await runDemo();

console.log(
  JSON.stringify(
    {
      status: summary.run.status,
      events: summary.run.events.map((event: RunEvent) => ({
        status: event.status,
        message: event.message
      })),
      safeIssue: summary.safeIssueScan,
      quarantinedIssue: summary.quarantinedIssueScan,
      validation: {
        status: summary.validation.status,
        before: summary.validation.before.status,
        afterExitCode: summary.validation.after.exitCode,
        regressionExitCode: summary.validation.regressions?.exitCode,
        filesChanged: summary.validation.filesChanged
      }
    },
    null,
    2
  )
);
