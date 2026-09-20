import { main } from "../migrate";

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
