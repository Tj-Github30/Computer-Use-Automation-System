import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);

async function serveStatic(filePath: string): Promise<{ status: number; contentType: string; body: string }> {
  const body = await readFile(filePath, "utf8");
  if (filePath.endsWith(".css")) {
    return { status: 200, contentType: "text/css", body };
  }
  if (filePath.endsWith(".js")) {
    return { status: 200, contentType: "application/javascript", body };
  }
  return { status: 200, contentType: "text/html", body };
}

export function createDemoAppServer(): Server {
  return createServer(async (req, res) => {
    try {
      const reqPath = (req.url ?? "/").split("?")[0];
      const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
      const filePath = path.join(__dirname, "web", cleanPath);
      const response = await serveStatic(filePath);
      res.writeHead(response.status, { "Content-Type": response.contentType });
      res.end(response.body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
}

export async function listenDemoApp(port = PORT): Promise<Server> {
  const server = createDemoAppServer();
  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });
  return server;
}

const launchedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]).includes(`${path.sep}demo-app${path.sep}server.`);

if (launchedDirectly) {
  listenDemoApp(PORT).then((server) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`Demo app running at http://localhost:${port}`);
  });
}
