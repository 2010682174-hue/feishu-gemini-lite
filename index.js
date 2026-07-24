const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// 建议读图使用 gemini-1.5-pro 或 gemini-2.5-flash 等多模态能力强的模型
const modelName = process.env.MODEL || 'gemini-1.5-pro';
const systemPrompt = process.env.SYSTEM_PROMPT || "你是一个高效的AI多模态助手。";

// 初始化飞书 SDK
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// 用户会话缓存 { openId: { chat, history } }
const userSessions = new Map();

app.post('/', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.status(200).send('OK');

  try {
    const event = req.body.event;
    if (!event || !event.message) return;

    const message = event.message;
    const msgType = message.message_type; // 'text' 或 'image'
    const openId = event.sender.sender_id.open_id;
    const messageId = message.message_id;

    // 初始化用户的 Gemini 模型与会话
    if (!userSessions.has(openId)) {
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: systemPrompt 
      });
      userSessions.set(openId, {
        chat: model.startChat({ history: [] })
      });
    }
    const session = userSessions.get(openId);

    // 1. 处理重置指令
    if (msgType === 'text') {
      const content = JSON.parse(message.content);
      const userText = content.text.trim();
      
      const resetCommands = ['#reset', '/clear', '重置', '清空记忆', '清除上下文'];
      if (resetCommands.includes(userText.toLowerCase())) {
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
        session.chat = model.startChat({ history: [] });
        await sendFeishuMessage(openId, "🧹 已经为您清除了所有对话上下文和图片记忆！");
        return;
      }

      console.log(`收到来自 ${openId} 的文本消息: ${userText}`);
      const result = await session.chat.sendMessage(userText);
      const replyText = result.response.text() || "Gemini 暂时没有返回内容。";
      await sendFeishuMessage(openId, replyText);

    } 
    // 2. 处理图片消息 (读图功能)
    else if (msgType === 'image') {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key; // 飞书图片的唯一标识

      console.log(`收到来自 ${openId} 的图片消息, image_key: ${imageKey}`);
      await sendFeishuMessage(openId, "收到图片，正在召唤 Gemini 仔细观察...");

      // 从飞书服务器下载图片二进制数据
      const imageResponse = await larkClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' }
      });

      // 将下载到的文件流转换为 Buffer，再转成 Base64 格式给 Gemini
      const imageBuffer = await streamToBuffer(imageResponse);
      const imageBase64 = imageBuffer.toString('base64');

      // 组装多模态输入（图片 + 默认提示词）
      const imagePart = {
        inlineData: {
          data: imageBase64,
          mimeType: "image/jpeg" // 飞书图片通用格式
        }
      };

      // 让 Gemini 针对这张图片进行分析（可以带上引导词）
      const prompt = "请帮我仔细看看这张图片，告诉我里面有什么，或者详细解读它。";
      const result = await session.chat.sendMessage([prompt, imagePart]);
      const replyText = result.response.text() || "这张图片太神秘了，Gemini 没看懂。";

      await sendFeishuMessage(openId, replyText);
    }

    console.log(`成功回复给 ${openId}`);
  } catch (err) {
    console.error('处理消息出错 (支持图文时异常):', err);
    try {
      if (req.body.event && req.body.event.sender) {
        await sendFeishuMessage(req.body.event.sender.sender_id.open_id, "哎呀，处理您的请求时出了一点小差错，请稍后再试~");
      }
    } catch (e) {}
  }
});

// 辅助函数：把流转换为 Buffer
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 辅助函数：发送飞书消息
async function sendFeishuMessage(openId, text) {
  await larkClient.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text: text })
    }
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Feishu Gemini Multimodal server is running on port ${PORT}`);
});
