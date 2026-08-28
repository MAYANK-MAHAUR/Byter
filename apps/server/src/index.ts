import { createReproSmithServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

createReproSmithServer().listen(port, "0.0.0.0", () => {
  console.log(`ReproSmith server listening on ${port}`);
});
