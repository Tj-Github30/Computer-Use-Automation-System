import { createServer } from "node:http";
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

const server = createServer(async (req, res) => {
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

server.listen(PORT, () => {
  console.log(`Demo app running at http://localhost:${PORT}`);
});
