// --- START OF FILE main.ts ---
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

// =======================================================
// 配置与环境变量检查
// =======================================================
// 1. 端口兼容：Deno Deploy 不需要 PORT，本地运行需要
const PORT = Number(Deno.env.get("PORT")) || 8000;

// 2. 调试日志：启动时打印环境变量状态（注意：生产环境日志可能看不到具体值，只能看到是否存在）
console.log("🚀 服务正在启动...");
console.log("⚙️ 当前端口配置:", PORT);
console.log("🔑 OPENROUTER_API_KEY 是否存在:", !!Deno.env.get("OPENROUTER_API_KEY"));
console.log("🔑 MODELSCOPE_API_KEY 是否存在:", !!Deno.env.get("MODELSCOPE_API_KEY"));

// --- 辅助函数：创建 JSON 错误响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// --- 辅助函数：休眠/等待 ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// =======================================================
// 模块 1: OpenRouter API 调用逻辑 (用于 nano banana)
// =======================================================
async function callOpenRouter(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
  if (!apiKey) {
    throw new Error("callOpenRouter received an empty apiKey.");
  }
  const openrouterPayload = {
    model: "google/gemini-2.5-flash-image-preview",
    messages
  };
  console.log("Sending payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));

  const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(openrouterPayload)
  });

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text();
    throw new Error(`OpenRouter API error: ${apiResponse.status} ${apiResponse.statusText} - ${errorBody}`);
  }

  const responseData = await apiResponse.json();
  console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));

  const message = responseData.choices?.[0]?.message;
  if (message?.images?.[0]?.image_url?.url) {
    return { type: 'image', content: message.images[0].image_url.url };
  }
  if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) {
    return { type: 'image', content: message.content };
  }
  if (typeof message?.content === 'string' && message.content.trim() !== '') {
    return { type: 'text', content: message.content };
  }
  return { type: 'text', content: "[模型没有返回有效内容]" };
}

// =======================================================
// 模块 2: ModelScope API 调用逻辑 (用于 Qwen-Image 等)
// =======================================================
async function callModelScope(model: string, apikey: string, parameters: any, timeoutSeconds: number): Promise<{ imageUrl: string }> {
  const base_url = 'https://api-inference.modelscope.cn/';
  const common_headers = {
    "Authorization": `Bearer ${apikey}`,
    "Content-Type": "application/json",
  };

  console.log(`[ModelScope] Submitting task for model: ${model}`);
  const generationResponse = await fetch(`${base_url}v1/images/generations`, {
    method: "POST",
    headers: {
      ...common_headers,
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({ model, ...parameters }),
  });

  if (!generationResponse.ok) {
    const errorBody = await generationResponse.text();
    throw new Error(`ModelScope API Error (Generation): ${generationResponse.status} - ${errorBody}`);
  }

  const { task_id } = await generationResponse.json();
  if (!task_id) {
    throw new Error("ModelScope API did not return a task_id.");
  }
  console.log(`[ModelScope] Task submitted. Task ID: ${task_id}`);

  const pollingIntervalSeconds = 5;
  const maxRetries = Math.ceil(timeoutSeconds / pollingIntervalSeconds);
  console.log(`[ModelScope] Task timeout set to ${timeoutSeconds}s, polling a max of ${maxRetries} times.`);

  for (let i = 0; i < maxRetries; i++) {
    await sleep(pollingIntervalSeconds * 1000);
    console.log(`[ModelScope] Polling task status... Attempt ${i + 1}/${maxRetries}`);
    const statusResponse = await fetch(`${base_url}v1/tasks/${task_id}`, {
      headers: {
        ...common_headers,
        "X-ModelScope-Task-Type": "image_generation"
      }
    });

    if (!statusResponse.ok) {
      console.error(`[ModelScope] Failed to get task status. Status: ${statusResponse.status}`);
      continue;
    }

    const data = await statusResponse.json();
    if (data.task_status === "SUCCEED") {
      console.log("[ModelScope] Task Succeeded.");
      if (data.output?.images?.[0]?.url) {
        return { imageUrl: data.output.images[0].url };
      } else if (data.output_images?.[0]) {
        return { imageUrl: data.output_images[0] };
      } else {
        throw new Error("ModelScope task succeeded but returned no images.");
      }
    } else if (data.task_status === "FAILED") {
      console.error("[ModelScope] Task Failed.", data);
      throw new Error(`ModelScope task failed: ${data.message || 'Unknown error'}`);
    }
  }
  throw new Error(`ModelScope task timed out after ${timeoutSeconds} seconds.`);
}

// =======================================================
// 主服务逻辑
// =======================================================
const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 处理跨域预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  // 健康检查或 Key 状态检查
  if (pathname === "/api/key-status") {
    const isSet = !!Deno.env.get("OPENROUTER_API_KEY");
    return new Response(JSON.stringify({ isSet }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (pathname === "/api/modelscope-key-status") {
    const isSet = !!Deno.env.get("MODELSCOPE_API_KEY");
    return new Response(JSON.stringify({ isSet }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 生成图片接口
  if (pathname === "/generate") {
    try {
      const requestData = await req.json();
      const { model, apikey, prompt, images, parameters, timeout } = requestData;

      if (model === 'nanobanana') {
        const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");
        if (!openrouterApiKey) {
          return createJsonErrorResponse("OpenRouter API key is not set.", 500);
        }
        if (!prompt) {
          return createJsonErrorResponse("Prompt is required.", 400);
        }

        const contentPayload: any[] = [{ type: "text", text: prompt }];
        if (images && Array.isArray(images) && images.length > 0) {
          const imageParts = images.map(img => ({ type: "image_url", image_url: { url: img } }));
          contentPayload.push(...imageParts);
        }
        const webUiMessages = [{ role: "user", content: contentPayload }];

        const result = await callOpenRouter(webUiMessages, openrouterApiKey);
        if (result.type === 'image') {
          return new Response(JSON.stringify({ imageUrl: result.content }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        } else {
          return createJsonErrorResponse(`Model returned text instead of an image: "${result.content}"`, 400);
        }
      } else {
        // ModelScope 逻辑
        const modelscopeApiKey = apikey || Deno.env.get("MODELSCOPE_API_KEY");
        if (!modelscopeApiKey) {
          return createJsonErrorResponse("ModelScope API key is not set.", 401);
        }
        if (!parameters?.prompt) {
          return createJsonErrorResponse("Positive prompt is required for ModelScope models.", 400);
        }

        const timeoutSeconds = timeout || (model.includes('Qwen') ? 120 : 180);
        const result = await callModelScope(model, modelscopeApiKey, parameters, timeoutSeconds);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    } catch (error) {
      console.error("Error handling /generate request:", error);
      return createJsonErrorResponse(error.message, 500);
    }
  }

  // 静态文件服务 (前端页面)
  // 注意：确保你的静态文件在 static 目录下
  return serveDir(req, {
    fsRoot: "static",
    urlRoot: "",
    showDirListing: true,
    enableCors: true
  });
};

// 启动服务
// 如果是 Deno Deploy，PORT 会被忽略，serve 会自动处理
// 如果是本地，会监听 8000
console.log(`🚀 Server is running on port ${PORT}`);
serve(handler, { port: PORT });
