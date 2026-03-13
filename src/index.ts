export interface Env {
  AI: any;
  API_KEY: string;
}

interface ModelConfig {
  models: string[];
}

const DEFAULT_MODELS = [
  "meta/llama-3.2-1b-instruct",
  "meta/llama-3.2-3b-instruct",
  "meta/llama-3.1-8b-instruct",
  "zai-org/glm-4.7-flash",
  "mistral/mistral-7b-instruct-v0.1",
];

function toWorkersAIModel(model: string): string {
  return model.startsWith("@cf/") ? model : `@cf/${model}`;
}

async function getAllowedModels(): Promise<string[]> {
  try {
    const modelsJson = await import("../models.json");
    return (modelsJson as ModelConfig).models || DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

function validateAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Missing or invalid Authorization header",
          type: "invalid_request_error",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const providedKey = authHeader.substring(7);
  
  if (providedKey !== env.API_KEY) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  return null;
}

function buildOpenAIResponse(requestId: string, model: string, choices: any[], usage?: any) {
  const response: any = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
  };

  if (usage) {
    response.usage = usage;
  }

  return response;
}

function buildSSELine(data: string): string {
  return `data: ${data}\n\n`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (path === "/v1/chat/completions" && method === "POST") {
      const authError = validateAuth(request, env);
      if (authError) return authError;
      return handleChatCompletions(request, env);
    }

    if (path === "/v1/embeddings" && method === "POST") {
      const authError = validateAuth(request, env);
      if (authError) return authError;
      return handleEmbeddings(request, env);
    }

    if (path === "/v1/models" && method === "GET") {
      const authError = validateAuth(request, env);
      if (authError) return authError;
      return handleModels(request);
    }

    if (path === "/health" && method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { messages, model, stream, temperature, max_tokens } = body;

    const allowedModels = await getAllowedModels();
    if (!allowedModels.includes(model)) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Model '${model}' is not allowed. Allowed models: ${allowedModels.join(", ")}`,
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const requestId = Math.random().toString(36).substring(2, 15);

    const aiOptions: any = {
      messages,
    };

    if (temperature !== undefined) {
      aiOptions.temperature = temperature;
    }

    if (max_tokens !== undefined) {
      aiOptions.max_tokens = max_tokens;
    }

    const result: any = await env.AI.run(toWorkersAIModel(model), aiOptions);

    if (stream) {
      const streamResponse = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const content = result.response || "";

          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(encoder.encode(buildSSELine(JSON.stringify(chunk))));

          const finalChunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };

          controller.enqueue(encoder.encode(buildSSELine(JSON.stringify(finalChunk))));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(streamResponse, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const response = buildOpenAIResponse(requestId, model, [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.response || "",
        },
        finish_reason: "stop",
      },
    ]);

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || "Internal error",
          type: "internal_error",
        },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function handleEmbeddings(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { input, model } = body;

    const allowedModels = await getAllowedModels();
    const embeddingModels = allowedModels.filter((m) => !m.includes("/"));

    if (!embeddingModels.includes(model)) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Model '${model}' is not allowed for embeddings`,
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const inputs = Array.isArray(input) ? input : [input];
    const requestId = Math.random().toString(36).substring(2, 15);
    const embeddings: any[] = [];

    for (const text of inputs) {
      const result: any = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text,
      });

      embeddings.push({
        object: "embedding",
        embedding: result.data[0].embedding,
        index: embeddings.length,
      });
    }

    const response = {
      object: "list",
      data: embeddings,
      model: model,
      usage: {
        prompt_tokens: inputs.reduce((acc, t) => acc + t.length, 0),
        total_tokens: inputs.reduce((acc, t) => acc + t.length, 0),
      },
    };

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || "Internal error",
          type: "internal_error",
        },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function handleModels(_request: Request): Promise<Response> {
  const allowedModels = await getAllowedModels();

  const models = allowedModels.map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cloudflare",
  }));

  return new Response(
    JSON.stringify({
      object: "list",
      data: models,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
