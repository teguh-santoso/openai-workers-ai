# OpenAI-Compatible API with Cloudflare Workers AI

Build your own OpenAI-compatible API using Cloudflare Workers AI. This project provides a proxy that translates OpenAI API requests to Cloudflare Workers AI.

## Prerequisites

- Cloudflare account
- Cloudflare API token with Workers AI permissions
- Node.js installed
- Wrangler CLI (`npm install -g wrangler`)

## Setup

### 1. Clone and Install Dependencies

```bash
# No external dependencies needed for this project
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

> **Note:** If you are already logged in with `wrangler login`, you don't need to add `CLOUDFLARE_API_TOKEN`. 
> 
> If not logged in, you must add your Cloudflare API token to `.env`.
> 
> To check login status: `wrangler whoami`
> 
> To login: `wrangler login`

### 3. Set API Key (Required)

For production, set the API_KEY as a Cloudflare Secret:

```bash
echo "your_api_key_here" | npx wrangler secret put API_KEY
```

For local development, you can add to `.dev.vars`:

```bash
# Edit .dev.vars
API_KEY=your_api_key_here
```

Then run `npx wrangler dev`

### 4. Configure Models

Edit `models.json` to enable the Workers AI models you want to use:

```json
{
  "models": [
    "@cf/meta/llama-3.1-8b-instruct",
    "@cf/meta/llama-3.1-70b-instruct",
    "@cf/mistral/mistral-7b-instruct-v0.1"
  ],
  "modelCosts": {
    "@cf/meta/llama-3.1-8b-instruct": { "inputPer1M": 2610, "outputPer1M": 2610 },
    "@cf/meta/llama-3.1-70b-instruct": { "inputPer1M": 10440, "outputPer1M": 10440 },
    "@cf/mistral/mistral-7b-instruct-v0.1": { "inputPer1M": 2610, "outputPer1M": 2610 }
  },
  "dailyLimit": 10000
}
```

- `modelCosts`: Neuron cost per 1M tokens for each model (input/output)
- `dailyLimit`: Maximum neurons per day (default: 10000 for free tier)

Available models can be found at [Cloudflare Workers AI Models](https://developers.cloudflare.com/workers-ai/models/).

### 5. Update Project Name

Edit `wrangler.toml` and set the `name` field to your desired worker name:

```toml
name = "your-project-name"
```

## Development

Run the worker locally:

```bash
npx wrangler dev
```

The API will be available at `http://localhost:8787`

## API Endpoints

All endpoints (except `/health`) require authentication using `Authorization: Bearer <API_KEY>` header.

### Chat Completions

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Streaming Chat Completions

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### List Available Models

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8787/v1/models
```

### Usage (Neuron Tracking)

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8787/v1/usage
```

Response:
```json
{
  "used": 2500,
  "limit": 10000,
  "remaining": 7500,
  "percentageRemaining": 75,
  "resetsAt": "2026-03-12T00:00:00.000Z"
}
```

### Response Headers

Every API response includes neuron usage headers:

```bash
X-Neurons-Used: 500
X-Neurons-Remaining: 9500
X-Neurons-Percentage-Remaining: 95%
```

### Health Check

```bash
curl http://localhost:8787/health
```

## Deployment

Deploy to Cloudflare Workers:

```bash
npx wrangler deploy
```

Your API will be available at `https://your-project-name.username.workers.dev`

## OpenAI SDK Usage

You can use this API with the OpenAI SDK by setting the base URL:

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "YOUR_API_KEY", // Your API key (from wrangler secret)
  baseURL: "https://your-project-name.username.workers.dev/v1",
});

const chatCompletion = await openai.chat.completions.create({
  model: "@cf/meta/llama-3.1-8b-instruct",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `API_KEY` | Required. Set via: `echo "KEY" \| npx wrangler secret put API_KEY` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token (required only if not logged in with wrangler) |

## Security Notes

- Never commit `.env` or `.dev.vars` files
- The `.gitignore` is configured to exclude these files
- If not logged in with wrangler, add `CLOUDFLARE_API_TOKEN` to `.env`
- Recommended: Run `wrangler login` to avoid storing tokens in `.env`
- **Always** use Cloudflare Secrets for `API_KEY`: `echo "YOUR_API_KEY" | npx wrangler secret put API_KEY`
- All API endpoints (except `/health`) require `Authorization: Bearer <API_KEY>` header

## License

MIT
