import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

// =======================================================
// 1. 配置与环境变量
// =======================================================
const CONFIG = {
  // 使用你在 Deno Deploy 后台设置的变量名
  API_KEY: Deno.env.get("AI_API_KEY") || "",
  BASE_URL: Deno.env.get("AI_BASE_URL") || "https://api.bltcy.ai/v1",
  // 端口逻辑修复：Deno Deploy 会忽略 PORT，本地运行时使用 8000
  PORT: Number(Deno.env.get("PORT")) || 8000,
};

// 简单的调试日志
console.log("🚀 服务正在启动...");
console.log("⚙️ 当前端口:", CONFIG.PORT);
console.log("🔑 API Key 是否存在:", !!CONFIG.API_KEY);
console.log("🌐 Base URL:", CONFIG.BASE_URL);

if (!CONFIG.API_KEY) {
  console.error("❌ 错误：未检测到 AI_API_KEY 环境变量！");
}

// =======================================================
// 2. 类型定义
// =======================================================
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
}

// =======================================================
// 3. 核心请求处理函数
// =======================================================
async function handleChat(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { model, messages, stream = false } = body as ChatRequest;

    // 检查 API Key
    if (!CONFIG.API_KEY) {
      return new Response(
        JSON.stringify({ error: "API Key 未配置，请检查环境变量" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 构建请求体
    const payload: ChatRequest = {
      model: model,
      messages: messages,
      stream: stream,
      temperature: 0.7,
    };

    // 发送请求到中转站
    const response = await fetch(`${CONFIG.BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // 处理流式响应
    if (stream) {
      const encoder = new TextEncoder();
      const customStream = new ReadableStream({
        async start(controller) {
          if (!response.body) {
            controller.close();
            return;
          }
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        },
      });

      return new Response(customStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 处理非流式响应
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("请求处理失败:", error);
    return new Response(
      JSON.stringify({ error: "内部服务器错误" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// =======================================================
// 4. 静态文件服务 (前端页面)
// =======================================================
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // API 路由
  if (url.pathname === "/v1/chat/completions") {
    return handleChat(req);
  }

  // 健康检查
  if (url.pathname === "/") {
    return new Response("🍌 NanoBanana API 正在运行", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  // 静态文件服务 (假设你有前端文件在 public 文件夹)
  // 注意：Deno Deploy 不支持直接读取本地文件系统，
  // 这里仅作为本地开发演示。在 Deno Deploy 上，你需要将前端打包或使用 CDN。
  try {
    return await serveDir(req, {
      fsRoot: "./public", // 你的静态文件目录
      showDirListing: false,
      showDotfiles: false,
      quiet: true,
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// =======================================================
// 5. 启动服务
// =======================================================

// 判断是否在 Deno Deploy 环境
// Deno Deploy 会自动注入 "DENO_DEPLOYMENT_ID" 这个环境变量
const isDeploy = !!Deno.env.get("DENO_DEPLOYMENT_ID");

if (isDeploy) {
  // 在云端：不传任何参数，让 Deno 自动处理
  console.log("☁️ 检测到云端环境，自动适配端口...");
  serve(handler);
} else {
  // 在本地：使用配置文件里的 8000 端口
  console.log(`💻 本地开发环境，监听端口 ${CONFIG.PORT}...`);
  serve(handler, { port: CONFIG.PORT });
}
