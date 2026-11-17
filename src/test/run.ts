import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 60000 });
  const suiteDirectory = path.join(__dirname, "suite");
  const files =
    process.env.RYL_TEST_MODE === "restricted"
      ? ["remoteSchema.test.js"]
      : fs.readdirSync(suiteDirectory).filter((file) => file.endsWith(".test.js"));
  for (const file of files) mocha.addFile(path.join(suiteDirectory, file));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures) reject(new Error(`${failures} tests failed`));
      else resolve();
    });
  });
}
