// Self-test journey that never finishes, for the hosted server's run timeout. It writes the
// process ids of its browser (the run process's children) to $SRJ_TEST_PID_FILE, so the test can
// check they are gone after the timeout.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export default {
  name: "Hanging journey",
  start: "/basic.html",
  async run() {
    if (process.env.SRJ_TEST_PID_FILE) {
      const children = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      writeFileSync(process.env.SRJ_TEST_PID_FILE, JSON.stringify({ run: process.pid, browsers: children.map(Number) }));
    }
    await new Promise(() => {});
  },
};
