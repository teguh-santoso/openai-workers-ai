export interface Env {
  AI: any;
  API_KEY: string;
}

interface ModelConfig {
  models: string[];
  modelCosts?: Record<string, { inputPer1M: number; outputPer1M: number }>;
  dailyLimit?: number;
}

const DEFAULT_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-70b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.1",
];

const DEFAULT_MODEL_COSTS: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "@cf/meta/llama-3.1-8b-instruct": { inputPer1M: 2610, outputPer1M: 2610 },
  "@cf/meta/llama-3.1-70b-instruct": { inputPer1M: 10440, outputPer1M: 10440 },
  "@cf/mistral/mistral-7b-instruct-v0.1": { inputPer1M: 2610, outputPer1M: 2610 },
};

const DEFAULT_DAILY_LIMIT = 10000;

let neuronUsage = {
  used: 0,
  resetAt: getNextResetTime(),
};

function getNextResetTime(): Date {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

function checkAndResetIfNeeded(): void {
  const now = new Date();
  if (now >= neuronUsage.resetAt) {
    neuronUsage.used = 0;
    neuronUsage.resetAt = getNextResetTime();
  }
}

async function getModelCosts(): Promise<Record<string, { inputPer1M: number; outputPer1M: number }>> {
  try {
    const modelsJson = await import("../models.json");
    return (modelsJson as ModelConfig).modelCosts || DEFAULT_MODEL_COSTS;
  } catch {
    return DEFAULT_MODEL_COSTS;
  }
}

async function getDailyLimit(): Promise<number> {
  try {
    const modelsJson = await import("../models.json");
    return (modelsJson as ModelConfig).dailyLimit || DEFAULT_DAILY_LIMIT;
  } catch {
    return DEFAULT_DAILY_LIMIT;
  }
}

function calculateNeurons(model: string, inputTokens: number, outputTokens: number, costs: Record<string, { inputPer1M: number; outputPer1M: number }>): number {
  const modelCost = costs[model] || DEFAULT_MODEL_COSTS[model] || { inputPer1M: 2610, outputPer1M: 2610 };
  const inputNeurons = (inputTokens / 1_000_000) * modelCost.inputPer1M;
  const outputNeurons = (outputTokens / 1_000_000) * modelCost.outputPer1M;
  return Math.ceil(inputNeurons + outputNeurons);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function getUsage(): Promise<{ used: number; limit: number; remaining: number; percentageRemaining: number; resetsAt: string }> {
  checkAndResetIfNeeded();
  const limit = await getDailyLimit();
  const remaining = Math.max(0, limit - neuronUsage.used);
  const percentageRemaining = Math.round((remaining / limit) * 100);
  
  return {
    used: neuronUsage.used,
    limit,
    remaining,
    percentageRemaining,
    resetsAt: neuronUsage.resetAt.toISOString(),
  };
}

function addNeuronUsage(neurons: number): void {
  checkAndResetIfNeeded();
  neuronUsage.used += neurons;
}

function getNeuronHeaders(limit: number): Record<string, string> {
  const remaining = Math.max(0, limit - neuronUsage.used);
  const percentageRemaining = Math.round((remaining / limit) * 100);
  
  return {
    "X-Neurons-Used": String(neuronUsage.used),
    "X-Neurons-Remaining": String(remaining),
    "X-Neurons-Percentage-Remaining": `${percentageRemaining}%`,
  };
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

    if (path === "/v1/usage" && method === "GET") {
      const authError = validateAuth(request, env);
      if (authError) return authError;
      return handleUsage(request);
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

    const inputText = messages.map((m: any) => m.content).join(" ");
    const inputTokens = estimateTokens(inputText);

    const result: any = await env.AI.run(model, aiOptions);

    const outputText = result.response || "";
    const outputTokens = estimateTokens(outputText);

    const modelCosts = await getModelCosts();
    const neuronsUsed = calculateNeurons(model, inputTokens, outputTokens, modelCosts);
    addNeuronUsage(neuronsUsed);

    const dailyLimit = await getDailyLimit();
    const neuronHeaders = getNeuronHeaders(dailyLimit);

    if (stream) {
      const streamResponse = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: outputText },
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
          ...neuronHeaders,
        },
      });
    }

    const response = buildOpenAIResponse(requestId, model, [
      {
        index: 0,
        message: {
          role: "assistant",
          content: outputText,
        },
        finish_reason: "stop",
      },
    ]);

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...neuronHeaders,
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
    const embeddingModels = allowedModels.filter((m) => m.startsWith("@cf/"));

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

async function handleUsage(_request: Request): Promise<Response> {
  const usage = await getUsage();

  return new Response(JSON.stringify(usage), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
