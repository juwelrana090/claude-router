import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.ROUTER_PORT || 21450);
const ROUTER_KEY = process.env.ROUTER_KEY || "local-router-key";

function loadEnv(): void {
  const file = ".env";

  if (!fs.existsSync(file)) {
    return;
  }

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");

    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

type ProviderName = "deepseek" | "zai" | "openrouter" | "anthropic";

type Provider = {
  baseURL: string;
  apiKey: () => string | undefined;
  transformModel: (model: string) => string;
};

const PROVIDERS: Record<ProviderName, Provider> = {
  deepseek: {
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: () => process.env.DEEPSEEK_API_KEY,
    transformModel: (model) => {
      if (model.startsWith("deepseek/")) {
        return model.slice("deepseek/".length);
      }

      return model;
    }
  },

  zai: {
    baseURL: "https://api.z.ai/api/anthropic",
    apiKey: () => process.env.ZAI_API_KEY,
    transformModel: (model) => {
      if (model.startsWith("zai/")) {
        return model.slice("zai/".length);
      }

      return model;
    }
  },

  openrouter: {
    baseURL: "https://openrouter.ai/api",
    apiKey: () => process.env.OPENROUTER_API_KEY,
    transformModel: (model) => {
      if (model.startsWith("openrouter/")) {
        return model.slice("openrouter/".length);
      }

      return model;
    }
  },

  anthropic: {
    baseURL: "https://api.anthropic.com",
    apiKey: () => process.env.ANTHROPIC_API_KEY,
    transformModel: (model) => {
      if (model.startsWith("anthropic/")) {
        return model.slice("anthropic/".length);
      }

      return model;
    }
  }
};

function resolveProvider(model: string): ProviderName {
  if (model.startsWith("deepseek/")) {
    return "deepseek";
  }

  if (model.startsWith("zai/")) {
    return "zai";
  }

  if (model.startsWith("openrouter/")) {
    return "openrouter";
  }

  if (model.startsWith("anthropic/")) {
    return "anthropic";
  }

  if (model.startsWith("deepseek-")) {
    return "deepseek";
  }

  if (model.startsWith("glm-")) {
    return "zai";
  }

  if (model.startsWith("claude-")) {
    return "anthropic";
  }

  return "openrouter";
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization || "";

  if (!ROUTER_KEY) {
    return true;
  }

  return auth === `Bearer ${ROUTER_KEY}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

interface MessagesRequestBody {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

async function proxyMessages(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const rawBody = await readBody(req);

    if (!rawBody) {
      return sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: "Request body is empty"
        }
      });
    }

    const body: MessagesRequestBody = JSON.parse(rawBody);

    if (!body.model) {
      return sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: "model is required"
        }
      });
    }

    const providerName = resolveProvider(body.model);
    const provider = PROVIDERS[providerName];

    if (!provider) {
      return sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: `Unknown provider for model: ${body.model}`
        }
      });
    }

    const apiKey = provider.apiKey();

    if (!apiKey) {
      return sendJSON(res, 500, {
        error: {
          type: "api_error",
          message: `${providerName.toUpperCase()}_API_KEY is not configured`
        }
      });
    }

    const upstreamModel = provider.transformModel(body.model);

    const upstreamURL =
      `${provider.baseURL}/v1/messages`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version":
        headerValue(req.headers["anthropic-version"]) || "2023-06-01"
    };

    const anthropicBeta = headerValue(req.headers["anthropic-beta"]);

    if (anthropicBeta) {
      headers["anthropic-beta"] = anthropicBeta;
    }

    const upstreamBody = {
      ...body,
      model: upstreamModel
    };

    console.log(
      `[ROUTER] ${body.model} -> ${providerName} -> ${upstreamModel}`
    );

    const upstream = await fetch(upstreamURL, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody)
    });

    res.statusCode = upstream.status;

    for (const [key, value] of upstream.headers) {
      if (
        key === "content-type" ||
        key === "cache-control" ||
        key === "connection"
      ) {
        res.setHeader(key, value);
      }
    }

    if (body.stream) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          res.write(chunk);
        }
      }

      res.end();
      return;
    }

    const responseText = await upstream.text();

    res.setHeader("Content-Type", "application/json");
    res.end(responseText);
  } catch (error) {
    console.error(error);

    sendJSON(res, 500, {
      error: {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    return sendJSON(res, 401, {
      error: {
        type: "authentication_error",
        message: "Invalid router key"
      }
    });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJSON(res, 200, {
      status: "ok"
    });
  }

  if (
    req.method === "POST" &&
    (req.url === "/v1/messages" || req.url === "/messages")
  ) {
    return proxyMessages(req, res);
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    return sendJSON(res, 200, {
      data: [
        {
          id: "deepseek/deepseek-flash",
          object: "model"
        },
        {
          id: "zai/glm-5",
          object: "model"
        },
        {
          id: "openrouter/anthropic/claude-sonnet-4",
          object: "model"
        },
        {
          id: "openrouter/openai/gpt-5",
          object: "model"
        },
        {
          id: "anthropic/claude-sonnet-4-5",
          object: "model"
        }
      ]
    });
  }

  sendJSON(res, 404, {
    error: {
      type: "not_found",
      message: "Not found"
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("Claude Multi-Provider Router");
  console.log("--------------------------------");
  console.log(`Running: http://127.0.0.1:${PORT}`);
  console.log("");
});
