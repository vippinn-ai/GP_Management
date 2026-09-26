import fs from "node:fs";
import path from "node:path";

export default class CompactEvidenceReporter {
  constructor(options = {}) {
    this.runId = options.runId || "unknown";
    this.startedAt = new Date().toISOString();
    this.tests = [];
  }

  onTestEnd(test, result) {
    this.tests.push({
      file: path.relative(this.testDir, test.location.file).replaceAll("\\", "/"),
      project: test.parent.project()?.name ?? "",
      title: test.titlePath().slice(1).filter(Boolean).join(" > "),
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
      errors: result.errors.map((error) => error.message?.split("\n")[0] || "Unknown error"),
      attachments: result.attachments.map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        path: attachment.path ? path.relative(process.cwd(), attachment.path) : undefined
      }))
    });
  }

  onBegin(config) {
    this.testDir = config.rootDir;
  }

  onEnd(result) {
    const directory = path.join(process.cwd(), "test-artifacts", "playwright");
    fs.mkdirSync(directory, { recursive: true });
    const summary = {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status,
      tests: this.tests
    };
    const output = path.join(directory, `summary-${this.runId}.json`);
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`Compact Playwright evidence: ${path.relative(process.cwd(), output)}`);
  }
}
