const express = require('express');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// ⚠️ 修正提示：目前 Gemini 最新模型代号为 3.5
const modelName = process.env.MODEL || 'gemini-3.5-flash'; 

// --- 自动注入当前实时时间 ---
const todayStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const customPrompt = process.env.SYSTEM_PROMPT || "你是一个高效的AI多模态助手。";
const systemPrompt = `${customPrompt}\n(系统实时参考：今天是 ${todayStr})`;

// --- AI 生成参数配置 ---
const generationConfig = {};
if (process.env.TEMPERATURE) generationConfig.temperature = parseFloat(process.env.TEMPERATURE);
if (process.env.TOP_K) generationConfig.topK = parseInt(process.env.TOP_K);
if (process.env.TOP_P) generationConfig.topP = parseFloat(process.env.TOP_P);
if (process.env.MAX_OUTPUT_TOKENS) generationConfig.maxOutputTokens = parseInt(process.env.MAX_OUTPUT_TOKENS);

// --- 安全限制配置 ---
const safetyThreshold = HarmBlockThreshold[process.env.SAFETY_THRESHOLD] || HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE;
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: safetyThreshold },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: safetyThreshold },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: safetyThreshold },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: safetyThreshold },
];

// --- 全局 Token 统计 ---
let globalUsedTokens = 0;
const maxTokenLimit = process.env.MAX_TOKEN_LIMIT ? parseInt(process.env.MAX_TOKEN_LIMIT) : 38000000;

const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// --- 状态存储 ---
const userSessions = new Map();         // 结构: { chatId: { chat, pendingMedia, isProcessing } }
const processedMessageIds = new Set();  // 【防抖防重试】记录处理过的飞书 message_id

// 🌟 主路由：接收飞书 Webhook
app.post('/', (req, res) => {
  // 1. 飞书的网址 URL 验证
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // 2. 【核心优化】立刻返回 200，彻底阻止飞书因为 3 秒超时而疯狂重试导致的 429 报错！
  res.status(200).json({ msg: "success" });

  // 3. 异步转入后台处理消息，不阻塞 HTTP 响应
  const event = req.body.event;
  if (event && event.message) {
    handleFeishuMessage(event).catch(err => console.error("后台处理消息彻底失败:", err));
  }
});

// 🌟 独立出来的异步消息处理核心函数
async function handleFeishuMessage(event) {
  const message = event.message;
  const msgType = message.message_type; // 'text', 'image', 'media'
  const messageId = message.message_id;
  const chatId = message.chat_id;

  // 🛡️ 防线 1：飞书重试拦截 (防并发 429)
  if (processedMessageIds.has(messageId)) {
    console.log(`♻️ 拦截飞书重复推送的事件 (message_id: ${messageId})`);
    return;
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 2000) processedMessageIds.clear(); // 定期清理内存防止 OOM

  // 🛡️ 防线 2：防机器人自我死循环
  if (event.sender && event.sender.sender_type === 'app') {
    console.log(`🤖 忽略机器人自己发出的消息`);
    return;
  }

  // --- Token 额度检查 ---
  if (globalUsedTokens >= maxTokenLimit) {
    await sendFeishuMessage(chatId, `🚫 服务已暂停，全局额度已用尽。\n\n已使用token: ${globalUsedTokens}/${maxTokenLimit}`);
    return;
  }

  // --- 初始化用户会话 ---
  if (!userSessions.has(chatId)) {
    const model = genAI.getGenerativeModel({ 
      model: modelName, 
      systemInstruction: systemPrompt,
      generationConfig: generationConfig,
      safetySettings: safetySettings,
      tools: [{ googleSearch: {} }] 
    });
    userSessions.set(chatId, {
      chat: model.startChat({ history: [] }),
      pendingMedia: null,
      isProcessing: false // 新增并发锁状态
    });
  }
  const session = userSessions.get(chatId);

  // 🛡️ 防线 3：单用户并发请求锁
  if (session.isProcessing) {
    await sendFeishuMessage(chatId, "⏳ 正在思考上一条消息，请等我回复后再发新消息哦...");
    return;
  }

  session.isProcessing = true; // 🔒 加上并发锁

  try {
    // 1. 处理文本消息
    if (msgType === 'text') {
      const content = JSON.parse(message.content);
      let userText = content.text.trim();
      
      const resetCommands = ['#reset', '/clear', '重置', '清空记忆', '清除上下文'];
      if (resetCommands.includes(userText.toLowerCase())) {
        const model = genAI.getGenerativeModel({ 
          model: modelName, 
          systemInstruction: systemPrompt,
          generationConfig: generationConfig,
          safetySettings: safetySettings,
          tools: [{ googleSearch: {} }]
        });
        session.chat = model.startChat({ history: [] });
        session.pendingMedia = null;
        await sendFeishuMessage(chatId, "🧹 已经为您清除了当前群/会话的所有对话上下文和暂存媒体文件！");
        return; // 注意：finally 块会自动解锁
      }

      // 网页链接自动抓取 (URL Scraper)
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = userText.match(urlRegex);
      if (urls && urls.length > 0) {
        const targetUrl = urls[0];
        console.log(`检测到网页链接，正在抓取: ${targetUrl}`);
        try {
          const scrapedContent = await fetchWebpageText(targetUrl);
          userText = `请阅读并分析以下网页内容（网址：${targetUrl}）：\n\n${scrapedContent}\n\n用户附加要求：${userText}`;
        } catch (scrapeErr) {
          console.error("网页抓取失败，退化为让 Gemini 直接联网搜索:", scrapeErr.message);
        }
      }

      // 如果有暂存的图片或视频
      if (session.pendingMedia) {
        console.log(`群/用户 ${chatId} 补充了媒体文件需求: ${userText}`);
        await sendFeishuMessage(chatId, "⏳ 收到需求，Gemini 正在全力解析媒体文件（大文件可能需要十余秒）...");

        const mediaPart = {
          inlineData: {
            data: session.pendingMedia.base64,
            mimeType: session.pendingMedia.mimeType
          }
        };

        const result = await session.chat.sendMessage([userText, mediaPart]);
        let replyText = result.response.text() || "Gemini 没有返回实质性内容。";

        const usedTokens = result.response.usageMetadata?.totalTokenCount || 0;
        globalUsedTokens += usedTokens;
        replyText += `\n\n*⚡ 已使用token: ${globalUsedTokens}/${maxTokenLimit}*`;

        session.pendingMedia = null; // 清除暂存
        await sendFeishuMessage(chatId, replyText);
        return;
      }

      // 普通纯文本对话
      console.log(`收到文本请求: ${userText}`);
      const result = await session.chat.sendMessage(userText);
      let replyText = result.response.text() || "Gemini 没有返回内容。";
      
      const usedTokens = result.response.usageMetadata?.totalTokenCount || 0;
      globalUsedTokens += usedTokens;
      replyText += `\n\n*⚡ 已使用token: ${globalUsedTokens}/${maxTokenLimit}*`;

      await sendFeishuMessage(chatId, replyText);

    } 
    // 2. 处理图片消息
    else if (msgType === 'image') {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key;
      console.log(`收到图片, 正在下载, image_key: ${imageKey}`);

      const imageResponse = await larkClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' }
      });
      const imageBuffer = await streamToBuffer(imageResponse);
      
      session.pendingMedia = {
        base64: imageBuffer.toString('base64'),
        mimeType: "image/jpeg"
      };
      await sendFeishuMessage(chatId, "📷 收到图片！请直接回复文字说明你的分析需求~");
    }
    // 3. 处理视频消息
    else if (msgType === 'media') {
      const content = JSON.parse(message.content);
      const fileKey = content.file_key;
      console.log(`收到视频, 正在下载, file_key: ${fileKey}`);
      
      await sendFeishuMessage(chatId, "⏳ 正在接收并下载您的视频，请稍候...");
      const videoResponse = await larkClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' }
      });
      const videoBuffer = await streamToBuffer(videoResponse);

      session.pendingMedia = {
        base64: videoBuffer.toString('base64'),
        mimeType: "video/mp4"
      };
      await sendFeishuMessage(chatId, "🎬 收到视频！请直接回复文字说明你的需求（例如：总结这个视频讲了什么）~");
    }

  } catch (err) {
    console.error('❌ 运行出错:', err);
    
    // 🛡️ 防线 4：优雅翻译 429 报错给用户
    let errorTips = `⚠️ AI 引擎运行出错：\n${(err.message || JSON.stringify(err)).substring(0, 150)}...`;
    
    if (err.message?.includes('429') || err.message?.includes('quota')) {
       errorTips = "🚨 **触发了 Gemini API 限制**\n当前请求人数过多或您的免费额度（15次/分钟）已被耗尽，请等待一分钟后再试！";
    } else if (err.message?.includes('fetch failed')) {
       errorTips = "📶 网络请求失败，Render 服务器连接 Google 出现拥堵，请重试。";
    }

    try {
      await sendFeishuMessage(chatId, errorTips);
    } catch (e) {
      console.error("发送错误提示给飞书也失败了:", e);
    }
  } finally {
    session.isProcessing = false; // 🔓 【关键】无论成功失败，确保解锁，否则该用户将永远被卡住
  }
}

// --- 辅助函数：抓取网页正文纯文本 ---
async function fetchWebpageText(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    timeout: 8000
  });
  const $ = cheerio.load(response.data);
  $('script, style, nav, footer, header').remove(); 
  return $('body').text().replace(/\s+/g, ' ').substring(0, 10000); 
}

// --- 通用流转 Buffer 函数 ---
async function streamToBuffer(input) {
  if (!input) throw new Error("输入对象为空");
  let stream = input;
  if (typeof input.getReadableStream === 'function') {
    stream = input.getReadableStream();
  } else if (input.body && typeof input.body.getReadableStream === 'function') {
    stream = input.body.getReadableStream();
  }
  if (stream && typeof stream.on === 'function') {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }
  if (Buffer.isBuffer(stream)) return stream;
  if (stream && stream.fileBuffer) return Buffer.from(stream.fileBuffer);
  throw new Error("无法从飞书响应中提取流");
}

// --- 发送飞书 Markdown 卡片 ---
async function sendFeishuMessage(chatId, text) {
  const cardContent = {
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content: text }]
  };
  await larkClient.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive', // interactive 类型才能渲染 Markdown
      content: JSON.stringify(cardContent)
    }
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
