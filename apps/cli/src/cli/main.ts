import { formatCliError, runHiddenServer } from "./core";
import { createExecutorCli } from "./app";

const main = async () => {
  const args = process.argv.slice(2);
  if (await runHiddenServer(args)) {
    return;
  }

  const cli = await createExecutorCli();
  await cli.run(args);
};

await main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
