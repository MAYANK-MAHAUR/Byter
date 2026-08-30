import { createByterServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

createByterServer().listen(port, "0.0.0.0", () => {
  console.log(`Byter server listening on ${port}`);
});
