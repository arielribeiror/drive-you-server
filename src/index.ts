import { config } from "./config.js";
import { prisma } from "./db.js";
import { buildServer } from "./server.js";

const app = await buildServer();

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({
  host: config.host,
  port: config.port,
});
